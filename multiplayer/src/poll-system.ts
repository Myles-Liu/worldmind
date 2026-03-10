/**
 * WorldMind Poll / Vote System
 *
 * Flow:
 *   1. Player creates poll → POST /api/poll/create { token, question }
 *   2. LLM generates options → returns draft { pollId, question, options }
 *   3. Player reviews/modifies → POST /api/poll/confirm { token, pollId, question?, options? }
 *   4. Poll goes live, broadcast to all
 *   5. Anyone votes → POST /api/action { action: "vote", pollId, optionIndex }
 *   6. NPCs vote during their round decisions
 *   7. Results queryable → GET /api/poll/results?pollId=
 *   8. Poll closes after N rounds or manually
 *
 * HTTP routes:
 *   POST /api/poll/create   { token, question }           → { pollId, question, options[] }
 *   POST /api/poll/confirm  { token, pollId, question?, options? } → { success, poll }
 *   GET  /api/poll/list     ?token=                        → { polls: [...] }
 *   GET  /api/poll/results  ?pollId=                       → { poll, results }
 *   POST /api/poll/close    { token, pollId }              → { success, results }
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { randomBytes } from 'crypto';

// ─── Types ──────────────────────────────────────────────────────

export interface PollOption {
  index: number;
  text: string;
}

export interface Poll {
  pollId: string;
  creatorId: number;
  creatorName: string;
  question: string;
  options: PollOption[];
  votes: Map<number, number>; // agentId → optionIndex
  status: 'draft' | 'active' | 'closed';
  createdAt: number;
  closedAt?: number;
  /** Auto-close after this many rounds (0 = manual close only) */
  autoCloseRounds: number;
  roundsActive: number;
}

export interface PollResult {
  pollId: string;
  question: string;
  options: Array<PollOption & { votes: number; voters: string[] }>;
  totalVotes: number;
  status: Poll['status'];
}

// ─── LLM interface ──────────────────────────────────────────────

export interface PollLlmConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

// ─── Dependencies ───────────────────────────────────────────────

export interface PollDeps {
  llm: PollLlmConfig;
  /** Resolve player token → { id, name } or null */
  resolveToken: (token: string) => { id: number; name: string } | null;
  /** Get agent display name by id */
  getAgentName: (id: number) => string;
  /** Broadcast event to all players */
  broadcast: (event: { type: string; data: unknown }) => void;
  /** World context for LLM */
  worldContext: string;
  log: (msg: string) => void;
}

// ─── Poll System ────────────────────────────────────────────────

export class PollSystem {
  private polls = new Map<string, Poll>();
  private deps: PollDeps;

  constructor(deps: PollDeps) {
    this.deps = deps;
  }

  /** Get active polls (for NPC decision context) */
  getActivePolls(): Poll[] {
    return [...this.polls.values()].filter(p => p.status === 'active');
  }

  /** Get a poll by id */
  getPoll(pollId: string): Poll | undefined {
    return this.polls.get(pollId);
  }

  /** Cast a vote (used by both HTTP action handler and NPC decisions) */
  vote(agentId: number, pollId: string, optionIndex: number): { success: boolean; error?: string } {
    const poll = this.polls.get(pollId);
    if (!poll) return { success: false, error: 'poll not found' };
    if (poll.status !== 'active') return { success: false, error: 'poll not active' };
    if (optionIndex < 0 || optionIndex >= poll.options.length) return { success: false, error: 'invalid option index' };

    const previousVote = poll.votes.get(agentId);
    poll.votes.set(agentId, optionIndex);

    const name = this.deps.getAgentName(agentId);
    if (previousVote !== undefined) {
      this.deps.log(`[poll] ${name} changed vote on "${poll.question}" → ${poll.options[optionIndex]!.text}`);
    } else {
      this.deps.log(`[poll] ${name} voted on "${poll.question}" → ${poll.options[optionIndex]!.text}`);
      // Broadcast vote event (not the choice, just that someone voted)
      this.deps.broadcast({
        type: 'poll_vote',
        data: { pollId, voterName: name, totalVotes: poll.votes.size },
      });
    }

    return { success: true };
  }

  /** Tick — call after each round. Auto-closes expired polls. */
  tickRound(): void {
    for (const [, poll] of this.polls) {
      if (poll.status === 'active') {
        poll.roundsActive++;
        if (poll.autoCloseRounds > 0 && poll.roundsActive >= poll.autoCloseRounds) {
          this.closePoll(poll);
        }
      }
    }
  }

  /** Build poll results */
  getResults(poll: Poll): PollResult {
    const optionResults = poll.options.map(opt => {
      const voters: string[] = [];
      for (const [agentId, idx] of poll.votes) {
        if (idx === opt.index) voters.push(this.deps.getAgentName(agentId));
      }
      return { ...opt, votes: voters.length, voters };
    });

    return {
      pollId: poll.pollId,
      question: poll.question,
      options: optionResults,
      totalVotes: poll.votes.size,
      status: poll.status,
    };
  }

  /** Get poll summary for NPC prompts */
  getPollSummaryForNpc(): string {
    const active = this.getActivePolls();
    if (active.length === 0) return '';

    const parts = active.map(p => {
      const opts = p.options.map(o => `  ${o.index}. ${o.text}`).join('\n');
      return `📊 投票: "${p.question}" (by ${p.creatorName})\n${opts}\n  已投票: ${p.votes.size}人 | pollId: ${p.pollId}`;
    });

    return `\n\n--- 当前投票 ---\n${parts.join('\n\n')}`;
  }

  // ─── HTTP Routes ──────────────────────────────────────────────

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    if (!path.startsWith('/api/poll/')) return false;

    const route = path.slice('/api/poll/'.length);

    if (req.method === 'GET') {
      if (route === 'list') return this.handleList(url, res);
      if (route === 'results') return this.handleResults(url, res);
      return this.json(res, 404, { error: `unknown poll route: ${route}` });
    }

    if (req.method !== 'POST') return this.json(res, 405, { error: 'POST or GET required' });

    const body = await readBody(req);

    switch (route) {
      case 'create': return this.handleCreate(body, res);
      case 'confirm': return this.handleConfirm(body, res);
      case 'close': return this.handleClose(body, res);
      default: return this.json(res, 404, { error: `unknown poll route: ${route}` });
    }
  }

  private async handleCreate(body: any, res: ServerResponse): Promise<true> {
    const player = this.deps.resolveToken(body.token);
    if (!player) return this.json(res, 401, { error: 'invalid token' });

    const { question } = body;
    if (!question || typeof question !== 'string') return this.json(res, 400, { error: 'question required' });

    // Generate options via LLM
    const options = await this.generateOptions(question);

    const pollId = randomBytes(6).toString('hex');
    const poll: Poll = {
      pollId,
      creatorId: player.id,
      creatorName: player.name,
      question,
      options,
      votes: new Map(),
      status: 'draft',
      createdAt: Date.now(),
      autoCloseRounds: typeof body.autoCloseRounds === 'number' ? body.autoCloseRounds : 5,
      roundsActive: 0,
    };

    this.polls.set(pollId, poll);
    this.deps.log(`[poll] Draft created by ${player.name}: "${question}" (${options.length} options)`);

    return this.json(res, 200, {
      pollId,
      question,
      options,
      message: 'Draft created. Review options and call /api/poll/confirm to publish.',
    });
  }

  private async handleConfirm(body: any, res: ServerResponse): Promise<true> {
    const player = this.deps.resolveToken(body.token);
    if (!player) return this.json(res, 401, { error: 'invalid token' });

    const { pollId } = body;
    const poll = this.polls.get(pollId);
    if (!poll) return this.json(res, 404, { error: 'poll not found' });
    if (poll.creatorId !== player.id) return this.json(res, 403, { error: 'only creator can confirm' });
    if (poll.status !== 'draft') return this.json(res, 400, { error: 'poll already confirmed' });

    // Allow modifications
    if (body.question && typeof body.question === 'string') poll.question = body.question;
    if (Array.isArray(body.options)) {
      poll.options = body.options.map((text: string, i: number) => ({ index: i, text }));
    }
    if (typeof body.autoCloseRounds === 'number') poll.autoCloseRounds = body.autoCloseRounds;

    poll.status = 'active';

    this.deps.log(`[poll] Published: "${poll.question}" with ${poll.options.length} options`);

    // Broadcast new poll to all
    this.deps.broadcast({
      type: 'poll_created',
      data: {
        pollId: poll.pollId,
        question: poll.question,
        options: poll.options,
        creatorName: poll.creatorName,
        autoCloseRounds: poll.autoCloseRounds,
      },
    });

    return this.json(res, 200, {
      success: true,
      poll: this.serializePoll(poll),
    });
  }

  private handleList(url: URL, res: ServerResponse): true {
    // token optional — list is public
    const polls = [...this.polls.values()].map(p => this.serializePoll(p));
    return this.json(res, 200, { polls });
  }

  private handleResults(url: URL, res: ServerResponse): true {
    const pollId = url.searchParams.get('pollId');
    if (!pollId) return this.json(res, 400, { error: 'pollId required' });

    const poll = this.polls.get(pollId);
    if (!poll) return this.json(res, 404, { error: 'poll not found' });

    return this.json(res, 200, this.getResults(poll));
  }

  private async handleClose(body: any, res: ServerResponse): Promise<true> {
    const player = this.deps.resolveToken(body.token);
    if (!player) return this.json(res, 401, { error: 'invalid token' });

    const poll = this.polls.get(body.pollId);
    if (!poll) return this.json(res, 404, { error: 'poll not found' });
    if (poll.creatorId !== player.id) return this.json(res, 403, { error: 'only creator can close' });
    if (poll.status === 'closed') return this.json(res, 400, { error: 'already closed' });

    this.closePoll(poll);
    return this.json(res, 200, { success: true, results: this.getResults(poll) });
  }

  // ─── Internal ─────────────────────────────────────────────────

  private closePoll(poll: Poll): void {
    poll.status = 'closed';
    poll.closedAt = Date.now();
    const results = this.getResults(poll);
    this.deps.log(`[poll] Closed: "${poll.question}" — ${results.totalVotes} votes`);
    this.deps.broadcast({ type: 'poll_closed', data: results });
  }

  private serializePoll(poll: Poll): Record<string, unknown> {
    return {
      pollId: poll.pollId,
      creatorName: poll.creatorName,
      question: poll.question,
      options: poll.options,
      totalVotes: poll.votes.size,
      status: poll.status,
      autoCloseRounds: poll.autoCloseRounds,
      roundsActive: poll.roundsActive,
    };
  }

  private async generateOptions(question: string): Promise<PollOption[]> {
    try {
      const response = await fetch(`${this.deps.llm.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.deps.llm.apiKey}`,
        },
        body: JSON.stringify({
          model: this.deps.llm.model,
          messages: [
            {
              role: 'system',
              content: `你是一个投票选项生成器。根据投票问题，生成 3-5 个有趣且有代表性的选项。

世界背景：${this.deps.worldContext.slice(0, 500)}

输出格式：每行一个选项，不要编号，不要多余说明。直接输出选项文本。`,
            },
            { role: 'user', content: `投票问题：${question}` },
          ],
          temperature: 0.8,
          max_tokens: 200,
        }),
      });

      const data = await response.json() as any;
      const text: string = data.choices?.[0]?.message?.content ?? '';
      const lines = text.split('\n').map((l: string) => l.replace(/^\d+[\.\)、]\s*/, '').trim()).filter((l: string) => l.length > 0);

      if (lines.length >= 2) {
        return lines.slice(0, 6).map((text: string, i: number) => ({ index: i, text }));
      }
    } catch (e) {
      this.deps.log(`[poll] LLM option generation failed: ${e}`);
    }

    // Fallback: generic options
    return [
      { index: 0, text: '非常同意' },
      { index: 1, text: '同意' },
      { index: 2, text: '中立' },
      { index: 3, text: '反对' },
    ];
  }

  // ─── Helpers ────────────────────────────────────────────────

  private json(res: ServerResponse, status: number, data: unknown): true {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return true;
  }
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

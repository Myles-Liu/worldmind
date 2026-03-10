/**
 * AgentDirector — "One Mind, Many Voices"
 *
 * Replaces OASIS's per-agent LLM calls with a single director LLM that
 * role-plays multiple agents in one call. OASIS becomes a pure platform
 * layer (DB + recommendation + timeline), and all reasoning happens here.
 *
 * Flow per round:
 * 1. Engine selects which agents are active this round
 * 2. Director reads each active agent's feed from OASIS DB
 * 3. One LLM call: "You are directing N characters. For each, decide their action."
 * 4. Parse structured output → ManualAction per agent
 * 5. Submit to OASIS via world-engine.py
 * 6. Update AgentMemoryManager with what happened
 */

import { LLMClient } from '../llm/client.js';
import { AgentMemoryManager } from './memory.js';
import type { AgentProfile, Post } from './types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface AgentPersona {
  id: number;
  username: string;
  role: string;
  personality: string;
}

export interface AgentFeedItem {
  postId: number;
  authorName: string;
  content: string;
  likes: number;
  comments: number;
}

export interface AgentDecision {
  agentId: number;
  action: 'post' | 'comment' | 'like' | 'follow' | 'repost' | 'quote'
    | 'create_group' | 'join_group' | 'leave_group' | 'send_to_group' | 'vote' | 'do_nothing';
  content?: string;      // for post/comment/quote/send_to_group
  targetPostId?: number; // for comment/like/repost/quote
  targetUserId?: number; // for follow
  groupId?: number;      // for join_group/leave_group/send_to_group
  groupName?: string;    // for create_group
  pollId?: string;       // for vote
  optionIndex?: number;  // for vote (0-based)
  reasoning?: string;    // internal monologue (logged, not shown)
}

export interface DirectorRoundInput {
  round: number;
  worldContext: string;
  agents: Array<{
    persona: AgentPersona;
    feed: AgentFeedItem[];
    memory: string;
    notifications: string[];
  }>;
}

// ─── Director ───────────────────────────────────────────────────

export class AgentDirector {
  private llm: LLMClient;
  private memoryManager: AgentMemoryManager;
  private personas: Map<number, AgentPersona> = new Map();
  private worldContext: string;
  private batchSize: number;

  constructor(options: {
    llm: LLMClient;
    memoryManager: AgentMemoryManager;
    worldContext: string;
    personas: AgentPersona[];
    batchSize?: number;
  }) {
    this.llm = options.llm;
    this.memoryManager = options.memoryManager;
    this.worldContext = options.worldContext;
    this.batchSize = options.batchSize ?? 5;
    for (const p of options.personas) {
      this.personas.set(p.id, p);
    }
  }

  /**
   * Direct a batch of agents for one round.
   * Returns decisions for each active agent.
   *
   * Batches agents into groups of ~5 per LLM call to balance
   * quality (enough context per agent) vs efficiency (fewer calls).
   */
  async directRound(input: DirectorRoundInput): Promise<AgentDecision[]> {
    const batches: DirectorRoundInput['agents'][] = [];

    for (let i = 0; i < input.agents.length; i += this.batchSize) {
      batches.push(input.agents.slice(i, i + this.batchSize));
    }

    const allDecisions: AgentDecision[] = [];

    for (const batch of batches) {
      const decisions = await this.directBatch(input.round, batch);
      allDecisions.push(...decisions);
    }

    // Update memory with decisions
    for (const d of allDecisions) {
      if (d.action !== 'do_nothing') {
        const persona = this.personas.get(d.agentId);
        const name = persona?.username ?? `agent_${d.agentId}`;
        this.memoryManager.recordAction(
          d.agentId, name, input.round,
          this.describeDecision(d),
          d.action === 'post' ? 0.8 : 0.5,
        );
      }
    }

    return allDecisions;
  }

  /**
   * Direct a single batch of agents (up to ~5).
   */
  private async directBatch(
    round: number,
    agents: DirectorRoundInput['agents'],
  ): Promise<AgentDecision[]> {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(round, agents);

    const response = await this.llm.complete(systemPrompt, userPrompt, {
      temperature: 0.8,
      maxTokens: 2000,
    });

    return this.parseDecisions(response, agents);
  }

  private buildSystemPrompt(): string {
    return `${this.worldContext}

# YOUR ROLE

You are the AgentDirector — a narrative engine that controls multiple characters in a social simulation. Each character has a distinct personality, memory, and social relationships.

For each character, you must decide their ONE action this round based on:
1. Their personality (stay in character!)
2. Their feed (what they see)
3. Their memory (what they remember)
4. Their relationships (who they like/dislike)

# RULES

- Each character acts independently — they don't know what others will do this round
- Characters should NOT all do the same thing. Some post, some lurk, some argue
- "do_nothing" is a perfectly valid action — not everyone posts every round
- Controversial posts should get reactions. Boring posts can be ignored
- Relationships matter: friends engage more, rivals challenge each other
- Keep posts concise and natural. No one writes essays on social media
- **CRITICAL: At least 30% of all actions should be interactions with existing posts (comment, like, repost, or quote), NOT new posts.** A real social feed is mostly reactions, not broadcasts. If the feed has interesting posts, PREFER commenting/liking/reposting over creating new posts.
- When commenting, reference the specific post content. Show you actually read it.
- When there are controversial or interesting posts in the feed, at least one character should react.
- Use "repost" to share someone's post without comment (signal boost). Use "quote" to share with your own take added.
- Use "follow" when a character finds someone genuinely interesting based on their posts — not randomly.

## GROUP CHATS
- Characters can create private group chats ("create_group"), join existing ones ("join_group"), and send messages ("send_to_group").
- Groups are for private coordination, side conversations, or conspiracies — things characters wouldn't say publicly.
- Don't overuse groups. Most rounds should still be public actions. Groups are for special moments:
  - Forming alliances or plotting
  - Sharing sensitive intel privately
  - Having casual private banter
- A character must be a member of a group before sending messages to it.

# OUTPUT FORMAT

Respond with a JSON array. Each element:
{
  "agentId": <number>,
  "action": "post" | "comment" | "like" | "follow" | "repost" | "quote" | "create_group" | "join_group" | "send_to_group" | "vote" | "do_nothing",
  "content": "<text for post/comment/quote/send_to_group — omit for like/repost/follow/join_group/vote/do_nothing>",
  "targetPostId": <number, for comment/like/repost/quote>,
  "targetUserId": <number, for follow>,
  "groupId": <number, for join_group/send_to_group>,
  "groupName": "<string, for create_group>",
  "pollId": "<string, for vote — see active polls below>",
  "optionIndex": <number, for vote — 0-based option index>,
  "reasoning": "<1 sentence internal thought>"
}

Return ONLY the JSON array, no other text.`;
  }

  private buildUserPrompt(round: number, agents: DirectorRoundInput['agents']): string {
    const parts: string[] = [`Round ${round}. Decide actions for ${agents.length} characters:\n`];

    for (const agent of agents) {
      parts.push(`--- CHARACTER: @${agent.persona.username} (id: ${agent.persona.id}) ---`);
      parts.push(`Role: ${agent.persona.role}`);
      parts.push(`Personality: ${agent.persona.personality}`);

      if (agent.memory) {
        parts.push(`Memory:\n${agent.memory}`);
      }

      if (agent.notifications.length > 0) {
        parts.push(`Notifications: ${agent.notifications.slice(0, 5).join('; ')}`);
      }

      if (agent.feed.length > 0) {
        parts.push('Feed:');
        for (const item of agent.feed.slice(0, 8)) {
          parts.push(`  [#${item.postId}] @${item.authorName}: ${item.content} (❤️${item.likes} 💬${item.comments})`);
        }
      } else {
        parts.push('Feed: (empty)');
      }

      parts.push('');
    }

    return parts.join('\n');
  }

  /**
   * Parse LLM response into structured decisions.
   * Tolerant of markdown fences, partial JSON, etc.
   */
  private parseDecisions(
    response: string,
    agents: DirectorRoundInput['agents'],
  ): AgentDecision[] {
    // Strip markdown fences
    let cleaned = response.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        return parsed.map(d => ({
          agentId: d.agentId,
          action: d.action ?? 'do_nothing',
          content: d.content,
          targetPostId: d.targetPostId,
          targetUserId: d.targetUserId,
          groupId: d.groupId,
          groupName: d.groupName,
          pollId: d.pollId,
          optionIndex: d.optionIndex,
          reasoning: d.reasoning,
        }));
      }
    } catch {
      // Fallback: try to extract individual JSON objects
      const objects: AgentDecision[] = [];
      const regex = /\{[^{}]*"agentId"\s*:\s*\d+[^{}]*\}/g;
      let match;
      while ((match = regex.exec(cleaned)) !== null) {
        try {
          const d = JSON.parse(match[0]);
          objects.push({
            agentId: d.agentId,
            action: d.action ?? 'do_nothing',
            content: d.content,
            targetPostId: d.targetPostId,
            targetUserId: d.targetUserId,
            groupId: d.groupId,
            groupName: d.groupName,
            pollId: d.pollId,
            optionIndex: d.optionIndex,
            reasoning: d.reasoning,
          });
        } catch { /* skip malformed */ }
      }
      if (objects.length > 0) return objects;
    }

    // Total failure: everyone does nothing
    console.error('[AgentDirector] Failed to parse LLM response, defaulting to do_nothing');
    return agents.map(a => ({
      agentId: a.persona.id,
      action: 'do_nothing' as const,
      reasoning: 'parse_failure',
    }));
  }

  private describeDecision(d: AgentDecision): string {
    switch (d.action) {
      case 'post': return `Posted: "${d.content ?? ''}"`;
      case 'comment': return `Commented on post #${d.targetPostId}: "${d.content ?? ''}"`;
      case 'like': return `Liked post #${d.targetPostId}`;
      case 'follow': return `Followed user #${d.targetUserId}`;
      case 'repost': return `Reposted post #${d.targetPostId}`;
      case 'quote': return `Quoted post #${d.targetPostId}: "${d.content ?? ''}"`;
      case 'create_group': return `Created group "${d.groupName ?? ''}"`;
      case 'join_group': return `Joined group #${d.groupId}`;
      case 'send_to_group': return `Sent to group #${d.groupId}: "${d.content ?? ''}"`;
      case 'vote': return `Voted on poll ${d.pollId} option ${d.optionIndex}`;
      default: return 'Did nothing';
    }
  }
}

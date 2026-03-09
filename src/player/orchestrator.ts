/**
 * SimulationOrchestrator — The brain of WorldMind social simulation
 *
 * Connects any AgentRuntime to the OASIS platform layer.
 * The orchestrator doesn't know or care how agents think —
 * it only knows they receive context and return decisions.
 *
 * Loop per round:
 * 1. Select active agents (randomized subset)
 * 2. Query OASIS DB for each agent's feed + notifications
 * 3. Delegate decisions to AgentRuntime (single or batch)
 * 4. Submit ManualActions to OASIS
 * 5. Notify agents of results (for memory/learning)
 */

import type { WorldEngine } from './engine.js';
import type {
  AgentRuntime,
  AgentSession,
  AgentDecision,
  RoundContext,
  AgentPersona,
  FeedItem,
  Notification,
} from './agent-runtime.js';

// ─── Types ──────────────────────────────────────────────────────

export interface OrchestratorConfig {
  /** OASIS engine instance */
  engine: WorldEngine;

  /** Agent runtime (OpenClaw, Director, or any implementation) */
  runtime: AgentRuntime;

  /** World-level context string */
  worldContext: string;

  /** Fraction of agents active per round (0-1). Default 0.7 */
  activityRate?: number;

  /** Feed items per agent per round. Default 10 */
  feedLimit?: number;

  /** Notification items per agent per round. Default 5 */
  notifLimit?: number;

  /** Callback for logging/UI */
  onLog?: (msg: string) => void;
}

export interface RoundResult {
  round: number;
  activeCount: number;
  decisions: AgentDecision[];
  executed: number;
  skipped: number;
}

// ─── Orchestrator ───────────────────────────────────────────────

export class SimulationOrchestrator {
  private engine: WorldEngine;
  private runtime: AgentRuntime;
  private worldContext: string;
  private activityRate: number;
  private feedLimit: number;
  private notifLimit: number;
  private log: (msg: string) => void;

  private sessions: AgentSession[] = [];
  private round = 0;

  constructor(config: OrchestratorConfig) {
    this.engine = config.engine;
    this.runtime = config.runtime;
    this.worldContext = config.worldContext;
    this.activityRate = config.activityRate ?? 0.7;
    this.feedLimit = config.feedLimit ?? 10;
    this.notifLimit = config.notifLimit ?? 5;
    this.log = config.onLog ?? (() => {});
  }

  /**
   * Initialize: spawn a runtime session for each agent.
   */
  async init(personas: AgentPersona[]): Promise<void> {
    this.log(`Spawning ${personas.length} agents via ${this.runtime.name} runtime...`);

    for (const persona of personas) {
      const session = await this.runtime.spawn(persona, this.worldContext);
      this.sessions.push(session);
      this.log(`  ✓ @${persona.username} → ${session.sessionId}`);
    }

    this.log(`All ${this.sessions.length} agents ready.`);
  }

  /**
   * Run one simulation round.
   */
  async step(): Promise<RoundResult> {
    this.round++;
    this.log(`\n─── Round ${this.round} ───`);

    // 1. Select active agents
    const activeCount = Math.max(
      3,
      Math.floor(this.sessions.length * (this.activityRate + (Math.random() - 0.5) * 0.2)),
    );
    const shuffled = [...this.sessions].sort(() => Math.random() - 0.5);
    const active = shuffled.slice(0, Math.min(activeCount, this.sessions.length));
    this.log(`${active.length}/${this.sessions.length} agents active`);

    // 2. Gather context for each active agent (sequential to avoid stdout race)
    const contexts = new Map<string, RoundContext>();
    for (const session of active) {
      const ctx = await this.gatherContext(session);
      contexts.set(session.sessionId, ctx);
    }

    // 3. Delegate decisions to runtime
    this.log(`${this.runtime.name} thinking...`);
    let decisions: AgentDecision[];

    if (this.runtime.decideBatch) {
      // Batch-capable runtime (Director, etc.)
      decisions = await this.runtime.decideBatch(active, contexts);
    } else {
      // Sequential per-agent (OpenClaw, etc.)
      decisions = [];
      for (const session of active) {
        const ctx = contexts.get(session.sessionId);
        if (!ctx) continue;
        const decision = await this.runtime.decide(session, ctx);
        decisions.push(decision);
      }
    }

    // 4. Log decisions
    for (const d of decisions) {
      const persona = this.sessions.find(s => s.agentId === d.agentId)?.persona;
      const name = persona?.username ?? `#${d.agentId}`;
      const icon = d.action === 'post' ? '📝' : d.action === 'comment' ? '💬'
        : d.action === 'like' ? '❤️' : d.action === 'follow' ? '👤'
        : d.action === 'repost' ? '🔄' : '😴';
      const detail = d.content ? `: ${d.content.slice(0, 60)}` : '';
      this.log(`  ${icon} @${name} → ${d.action}${detail}`);
      if (d.reasoning) this.log(`     (${d.reasoning})`);
    }

    // 5. Submit to OASIS
    const actionDecisions = decisions.filter(d => d.action !== 'do_nothing');
    let executed = 0;
    let skipped = decisions.length - actionDecisions.length;

    if (actionDecisions.length > 0) {
      const result = await this.engine.directedStep(actionDecisions);
      executed = result.executed;
      skipped += result.skipped;
      this.log(`✓ Executed ${result.executed} actions, ${result.skipped} skipped`);
    } else {
      this.log('All agents chose to lurk this round.');
    }

    // 6. Notify agents of results (for memory)
    if (this.runtime.onActionResult) {
      for (const d of decisions) {
        const session = this.sessions.find(s => s.agentId === d.agentId);
        if (session) {
          await this.runtime.onActionResult(session, d, true).catch(() => {});
        }
      }
    }

    return { round: this.round, activeCount: active.length, decisions, executed, skipped };
  }

  /**
   * Run multiple rounds.
   */
  async run(rounds: number): Promise<RoundResult[]> {
    const results: RoundResult[] = [];
    for (let i = 0; i < rounds; i++) {
      results.push(await this.step());
    }
    return results;
  }

  /**
   * Shutdown everything.
   */
  async shutdown(): Promise<void> {
    this.log('Shutting down...');
    await this.runtime.shutdownAll();
    await this.engine.shutdown();
  }

  // ─── Getters ──────────────────────────────────────────────────

  get currentRound(): number { return this.round; }
  get agentSessions(): ReadonlyArray<AgentSession> { return this.sessions; }

  // ─── Internal ─────────────────────────────────────────────────

  private async gatherContext(session: AgentSession): Promise<RoundContext> {
    const feedRaw = await this.engine.queryAgentFeed(session.agentId, this.feedLimit);
    const notifsRaw = await this.engine.queryAgentNotifications(session.agentId, this.notifLimit);

    const feed: FeedItem[] = feedRaw.map(f => ({
      postId: f.post_id,
      authorName: f.author_name,
      content: f.content,
      likes: f.num_likes,
      comments: f.num_comments,
    }));

    const notifications: Notification[] = notifsRaw.map(n => ({
      type: n.type,
      fromAgent: n.from_agent,
      content: n.content,
    }));

    return {
      round: this.round,
      feed,
      notifications,
      worldContext: this.worldContext,
    };
  }
}

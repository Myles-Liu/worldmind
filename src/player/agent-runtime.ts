/**
 * AgentRuntime — Pluggable agent backend interface
 *
 * WorldMind's simulation orchestrator doesn't care HOW an agent thinks,
 * only that it can receive context and return a decision. This interface
 * abstracts the agent execution layer.
 *
 * Implementations:
 * - OpenClawRuntime: one OpenClaw sub-session per agent (rich, persistent)
 * - DirectorRuntime: batched LLM calls via AgentDirector (efficient)
 * - Future: LangChain, AutoGen, CAMEL, local LLM, human-in-the-loop, etc.
 */

// ─── Types ──────────────────────────────────────────────────────

export interface AgentPersona {
  id: number;
  username: string;
  role: string;
  personality: string;
}

export interface FeedItem {
  postId: number;
  authorName: string;
  content: string;
  likes: number;
  comments: number;
}

export interface Notification {
  type: string;       // 'comment' | 'follow' | 'like' | ...
  fromAgent: string;
  content: string;
}

/**
 * What the orchestrator sends to an agent each round.
 */
export interface RoundContext {
  round: number;
  feed: FeedItem[];
  notifications: Notification[];
  memory?: string;            // optional memory summary from previous rounds
  worldContext?: string;       // world-level directives (language, culture, etc.)
}

/**
 * What an agent returns after deliberation.
 */
export interface AgentDecision {
  agentId: number;
  action: 'post' | 'comment' | 'like' | 'follow' | 'repost' | 'quote' | 'do_nothing';
  content?: string;
  targetPostId?: number;
  targetUserId?: number;
  reasoning?: string;         // optional explanation (for logging/debugging)
}

/**
 * Handle to a spawned agent session. Opaque to the orchestrator.
 */
export interface AgentSession {
  agentId: number;
  sessionId: string;          // runtime-specific session identifier
  persona: AgentPersona;
}

// ─── Interface ──────────────────────────────────────────────────

export interface AgentRuntime {
  readonly name: string;

  /**
   * Spawn an agent session. Called once per agent at simulation start.
   * The runtime should prepare whatever resources it needs (LLM session,
   * sub-process, API connection, etc.)
   */
  spawn(persona: AgentPersona, worldContext: string): Promise<AgentSession>;

  /**
   * Ask an agent to decide their action for this round.
   * The runtime receives the full round context and must return a decision.
   *
   * For batch-oriented runtimes (like DirectorRuntime), the orchestrator
   * will call decideBatch() instead. Single-agent runtimes implement this.
   */
  decide(session: AgentSession, context: RoundContext): Promise<AgentDecision>;

  /**
   * Optional batch interface for runtimes that are more efficient
   * processing multiple agents at once (e.g. DirectorRuntime).
   * Default: calls decide() sequentially for each agent.
   */
  decideBatch?(
    sessions: AgentSession[],
    contexts: Map<string, RoundContext>,
  ): Promise<AgentDecision[]>;

  /**
   * Notify the agent of what happened after their action was executed.
   * Used for memory/learning. Optional — not all runtimes need this.
   */
  onActionResult?(session: AgentSession, decision: AgentDecision, success: boolean): Promise<void>;

  /**
   * Tear down a single agent session.
   */
  destroy(session: AgentSession): Promise<void>;

  /**
   * Tear down all sessions and cleanup runtime resources.
   */
  shutdownAll(): Promise<void>;
}

// ─── Base class with default batch implementation ───────────────

export abstract class BaseAgentRuntime implements AgentRuntime {
  abstract readonly name: string;

  abstract spawn(persona: AgentPersona, worldContext: string): Promise<AgentSession>;
  abstract decide(session: AgentSession, context: RoundContext): Promise<AgentDecision>;
  abstract destroy(session: AgentSession): Promise<void>;
  abstract shutdownAll(): Promise<void>;

  /**
   * Default batch: sequential decide() calls.
   * Override in batch-optimized runtimes.
   */
  async decideBatch(
    sessions: AgentSession[],
    contexts: Map<string, RoundContext>,
  ): Promise<AgentDecision[]> {
    const decisions: AgentDecision[] = [];
    for (const session of sessions) {
      const ctx = contexts.get(session.sessionId);
      if (!ctx) continue;
      const decision = await this.decide(session, ctx);
      decisions.push(decision);
    }
    return decisions;
  }
}

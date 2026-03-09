/**
 * DirectorRuntime — Batched LLM calls via AgentDirector (Plan 2)
 *
 * Wraps the existing AgentDirector as an AgentRuntime implementation.
 * One LLM call handles ~5 agents at once. More efficient, less "individual".
 *
 * This serves as both a practical runtime and a reference for how to
 * adapt non-session-based agent systems to the AgentRuntime interface.
 */

import {
  BaseAgentRuntime,
  type AgentPersona,
  type AgentSession,
  type RoundContext,
  type AgentDecision,
} from './agent-runtime.js';
import { AgentDirector, type AgentPersona as DirectorPersona } from './agent-director.js';
import { AgentMemoryManager } from './memory.js';
import { LLMClient } from '../llm/client.js';

// ─── Types ──────────────────────────────────────────────────────

export interface DirectorRuntimeConfig {
  llm: {
    apiKey: string;
    baseURL: string;
    model: string;
  };
  worldContext: string;
  batchSize?: number;
  memoryPath?: string;
  maxEntriesPerAgent?: number;
}

// ─── Implementation ─────────────────────────────────────────────

export class DirectorRuntime extends BaseAgentRuntime {
  readonly name = 'director';

  private director: AgentDirector;
  private memoryManager: AgentMemoryManager;
  private sessions: Map<string, AgentSession> = new Map();
  private personas: DirectorPersona[] = [];
  private worldContext: string;

  constructor(config: DirectorRuntimeConfig) {
    super();
    this.worldContext = config.worldContext;

    this.memoryManager = new AgentMemoryManager({
      maxEntriesPerAgent: config.maxEntriesPerAgent ?? 50,
      savePath: config.memoryPath,
    });

    const llm = new LLMClient({
      apiKey: config.llm.apiKey,
      baseURL: config.llm.baseURL,
      model: config.llm.model,
    });

    // Director will be initialized with personas on first decideBatch
    this.director = new AgentDirector({
      llm,
      memoryManager: this.memoryManager,
      worldContext: config.worldContext,
      personas: [], // populated during spawn
      batchSize: config.batchSize,
    });
  }

  async spawn(persona: AgentPersona, _worldContext: string): Promise<AgentSession> {
    const sessionId = `director-${persona.id}-${persona.username}`;
    const session: AgentSession = { agentId: persona.id, sessionId, persona };

    this.sessions.set(sessionId, session);
    const dp = {
      id: persona.id,
      username: persona.username,
      role: persona.role,
      personality: persona.personality,
    };
    this.personas.push(dp);

    // Register persona with director (it uses a Map internally)
    (this.director as any).personas.set(persona.id, dp);

    return session;
  }

  /**
   * Single-agent decide: wraps into a batch of 1.
   */
  async decide(session: AgentSession, context: RoundContext): Promise<AgentDecision> {
    const results = await this.decideBatch(
      [session],
      new Map([[session.sessionId, context]]),
    );
    return results[0] ?? { agentId: session.agentId, action: 'do_nothing' };
  }

  /**
   * Batch decide: the director's sweet spot.
   */
  async decideBatch(
    sessions: AgentSession[],
    contexts: Map<string, RoundContext>,
  ): Promise<AgentDecision[]> {
    // Build agent inputs for the director
    const agentInputs = sessions.map(s => {
      const ctx = contexts.get(s.sessionId);
      return {
        persona: {
          id: s.agentId,
          username: s.persona.username,
          role: s.persona.role,
          personality: s.persona.personality,
        },
        feed: (ctx?.feed ?? []).map(f => ({
          postId: f.postId,
          authorName: f.authorName,
          content: f.content,
          likes: f.likes,
          comments: f.comments,
        })),
        memory: ctx?.memory ?? '',
        notifications: (ctx?.notifications ?? []).map(
          n => `${n.fromAgent} ${n.type}: ${n.content}`
        ),
      };
    });

    const round = contexts.values().next().value?.round ?? 0;

    const decisions = await this.director.directRound({
      round,
      worldContext: this.worldContext,
      agents: agentInputs,
    });

    return decisions;
  }

  async onActionResult(_session: AgentSession, decision: AgentDecision, _success: boolean): Promise<void> {
    // Director already records to memory in directRound
    this.memoryManager.save();
  }

  async destroy(session: AgentSession): Promise<void> {
    this.sessions.delete(session.sessionId);
    this.personas = this.personas.filter(p => p.id !== session.agentId);
  }

  async shutdownAll(): Promise<void> {
    this.memoryManager.save();
    this.sessions.clear();
    this.personas = [];
  }
}

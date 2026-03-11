/**
 * OasisNpcRuntime — Uses OASIS native LLM-driven agents for NPC actions.
 *
 * Instead of batched director decisions, each NPC independently calls LLM
 * via OASIS's `env.step(LLMAction)`. This gives each agent true independence.
 */

import type { NpcRuntime, Persona, Decision, FeedItem, Notification } from './types.js';
import type { WorldEngine } from '../../src/player/engine.js';

export interface OasisRuntimeConfig {
  engine: WorldEngine;
  npcIds: number[];
}

export class OasisNpcRuntime implements NpcRuntime {
  readonly name = 'OASIS Native';

  private engine: WorldEngine;
  private npcIds: number[];
  private sessions: Map<string, Persona> = new Map();

  constructor(config: OasisRuntimeConfig) {
    this.engine = config.engine;
    this.npcIds = config.npcIds;
  }

  /** Spawn an NPC — just registers it, OASIS already created the agent */
  async spawn(persona: Persona, _worldContext: string): Promise<{ sessionId: string }> {
    const sessionId = `npc_${persona.id}`;
    this.sessions.set(sessionId, persona);
    return { sessionId };
  }

  /**
   * Decide for a single NPC — not used in OASIS native mode.
   * Returns do_nothing since OASIS step handles all decisions.
   */
  async decide(_sessionId: string, _context: {
    round: number;
    feed: FeedItem[];
    notifications: Notification[];
  }): Promise<Decision> {
    return { action: 'do_nothing' };
  }

  /**
   * Batch decide for all NPCs — triggers OASIS native step.
   * Each agent independently calls LLM via OASIS's SocialAgent + Function Calling.
   */
  async decideBatch(
    _sessionIds: string[],
    _contexts: Map<string, {
      round: number;
      feed: FeedItem[];
      notifications: Notification[];
    }>
  ): Promise<Decision[]> {
    // Trigger OASIS native step — each NPC independently decides via LLM
    try {
      await this.engine.adminAct({ type: 'step', rounds: 1 });
    } catch (e) {
      console.error('[OasisNpcRuntime] step error:', e);
    }

    // OASIS writes actions directly to DB via function calling.
    // Return empty decisions — the platform adapter reads from DB on next poll.
    return [];
  }

  /** Shutdown — nothing to clean up, OASIS engine handles lifecycle */
  async shutdownAll(): Promise<void> {
    // Engine shutdown is handled by the server
  }
}

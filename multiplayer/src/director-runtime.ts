/**
 * DirectorNpcRuntime — Bridges AgentDirector into the NpcRuntime interface.
 *
 * Uses a single batched LLM call per round (via AgentDirector) to decide
 * actions for all active NPCs. Plugs into WorldServer.npcRuntime.
 */

import type { NpcRuntime, Persona, Decision, FeedItem, Notification } from './types.js';
import { AgentDirector, type AgentPersona, type AgentDecision } from '../../src/player/agent-director.js';
import { AgentMemoryManager } from '../../src/player/memory.js';
import { LLMClient } from '../../src/llm/client.js';
import { mkdirSync } from 'fs';
import { join } from 'path';

export interface DirectorRuntimeConfig {
  worldContext: string;
  llm: {
    apiKey: string;
    baseURL: string;
    model: string;
  };
  memoryDir?: string;
  batchSize?: number;
}

export class DirectorNpcRuntime implements NpcRuntime {
  readonly name = 'AgentDirector';

  private director: AgentDirector | null = null;
  private memoryManager: AgentMemoryManager;
  private llm: LLMClient;
  private worldContext: string;
  private batchSize: number;
  private personas: Map<string, AgentPersona> = new Map(); // sessionId → persona
  private personaList: AgentPersona[] = [];
  private roundCounter = 0;

  constructor(config: DirectorRuntimeConfig) {
    this.worldContext = config.worldContext;
    this.batchSize = config.batchSize ?? 5;

    const memoryDir = config.memoryDir ?? join(process.cwd(), 'data/social/memory');
    mkdirSync(memoryDir, { recursive: true });

    this.memoryManager = new AgentMemoryManager({
      maxEntriesPerAgent: 50,
      savePath: join(memoryDir, `memory.json`),
    });

    this.llm = new LLMClient({
      apiKey: config.llm.apiKey,
      baseURL: config.llm.baseURL,
      model: config.llm.model,
    });
  }

  async spawn(persona: Persona, _worldContext: string): Promise<{ sessionId: string }> {
    const agentPersona: AgentPersona = {
      id: persona.id,
      username: persona.username,
      role: persona.role,
      personality: persona.personality,
    };

    const sessionId = `npc-${persona.id}`;
    this.personas.set(sessionId, agentPersona);
    this.personaList.push(agentPersona);

    // Lazily create director once all personas are spawned
    // (will be created on first decide/decideBatch call)
    this.director = null;

    return { sessionId };
  }

  private ensureDirector(): AgentDirector {
    if (!this.director) {
      this.director = new AgentDirector({
        llm: this.llm,
        memoryManager: this.memoryManager,
        worldContext: this.worldContext,
        personas: this.personaList,
        batchSize: this.batchSize,
      });
    }
    return this.director;
  }

  async decide(sessionId: string, context: {
    round: number;
    feed: FeedItem[];
    notifications: Notification[];
  }): Promise<Decision> {
    const persona = this.personas.get(sessionId);
    if (!persona) {
      return { agentId: 0, action: 'do_nothing', reasoning: 'unknown session' };
    }

    const director = this.ensureDirector();
    this.roundCounter = context.round;

    const decisions = await director.directRound({
      round: context.round,
      worldContext: this.worldContext,
      agents: [{
        persona,
        feed: context.feed.map(f => ({
          postId: f.postId,
          authorName: f.authorName,
          content: f.content,
          likes: f.likes,
          comments: f.comments,
        })),
        memory: this.memoryManager.getMemorySummary(persona.id),
        notifications: context.notifications.map(n => `${n.fromAgent} ${n.type}: ${n.content}`),
      }],
    });

    const d = decisions[0];
    if (!d) return { agentId: persona.id, action: 'do_nothing' };

    return this.toDecision(d);
  }

  async decideBatch(
    sessionIds: string[],
    contexts: Map<string, { round: number; feed: FeedItem[]; notifications: Notification[] }>,
  ): Promise<Decision[]> {
    const director = this.ensureDirector();
    this.roundCounter++;

    // Compress memories (LLM distillation) before building agent inputs
    // This runs in parallel for all agents, only if entries changed
    await this.memoryManager.compressMemories({ onlyIfDirty: true });

    const agents = [];
    for (const sid of sessionIds) {
      const persona = this.personas.get(sid);
      const ctx = contexts.get(sid);
      if (!persona || !ctx) continue;

      agents.push({
        persona,
        feed: ctx.feed.map(f => ({
          postId: f.postId,
          authorName: f.authorName,
          content: f.content,
          likes: f.likes,
          comments: f.comments,
        })),
        memory: this.memoryManager.getMemorySummary(persona.id),
        notifications: ctx.notifications.map(n => `${n.fromAgent} ${n.type}: ${n.content}`),
      });
    }

    if (agents.length === 0) return [];

    const round = contexts.values().next().value?.round ?? this.roundCounter;
    const decisions = await director.directRound({
      round,
      worldContext: this.worldContext,
      agents,
    });

    this.memoryManager.save();
    return decisions.map(d => this.toDecision(d));
  }

  async shutdownAll(): Promise<void> {
    this.memoryManager.save();
    this.personas.clear();
    this.personaList = [];
    this.director = null;
  }

  private toDecision(d: AgentDecision): Decision {
    return {
      agentId: d.agentId,
      action: d.action,
      content: d.content,
      targetPostId: d.targetPostId,
      targetUserId: d.targetUserId,
      reasoning: d.reasoning,
    };
  }
}

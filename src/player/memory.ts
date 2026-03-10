/**
 * Agent Memory Manager
 *
 * Maintains persistent memory for each agent across simulation rounds.
 * Injects memory summaries into agent prompts via the Python bridge.
 *
 * Memory types:
 * - Episodic: what happened (posts seen, interactions had)
 * - Social: relationships (who they like/dislike, who interacted with them)
 * - Semantic: learned facts and opinions formed during simulation
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDefaultLLMClient } from '../llm/client.js';

// ─── Compression Prompt ─────────────────────────────────────────

const COMPRESS_SYSTEM_PROMPT = `You are a memory compression engine. Given an agent's full memory log, distill it into a concise summary that preserves:

1. Key events (what the agent did and experienced)
2. Important relationships (who they interacted with and how)
3. Formed opinions and insights
4. Emotional tone and personality quirks shown

Rules:
- Output ONLY the compressed summary, no explanations
- Keep the same perspective (first person if original was first person)
- Preserve specific names, numbers, and key details
- Use bullet points for clarity
- Target the specified character length
- Prioritize recent and high-importance events`;

// ─── Types ──────────────────────────────────────────────────────

export interface AgentMemoryEntry {
  round: number;
  type: 'episodic' | 'social' | 'semantic';
  content: string;
  importance: number; // 0-1
  timestamp: string;
}

export interface AgentMemoryState {
  agentId: number;
  agentName: string;
  entries: AgentMemoryEntry[];
  relationships: Map<number, RelationshipState>;
  /** LLM-compressed summary cache */
  compressedSummary?: string;
  /** Entries count when summary was last compressed */
  compressedAtCount?: number;
}

export interface RelationshipState {
  targetId: number;
  targetName: string;
  sentiment: number; // -1 to 1
  interactions: number;
  lastInteraction: string;
  notes: string[];
}

// ─── Memory Manager ─────────────────────────────────────────────

export class AgentMemoryManager {
  private memories: Map<number, AgentMemoryState> = new Map();
  private maxEntriesPerAgent: number;
  private savePath: string | null;

  constructor(options?: {
    maxEntriesPerAgent?: number;
    savePath?: string;
  }) {
    this.maxEntriesPerAgent = options?.maxEntriesPerAgent ?? 50;
    this.savePath = options?.savePath ?? null;

    // Load from disk if exists
    if (this.savePath && existsSync(this.savePath)) {
      this.load();
    }
  }

  /**
   * Record what an agent did this round.
   */
  recordAction(agentId: number, agentName: string, round: number, action: string, importance = 0.5): void {
    const mem = this.getOrCreate(agentId, agentName);
    mem.entries.push({
      round,
      type: 'episodic',
      content: action,
      importance,
      timestamp: new Date().toISOString(),
    });
    this.trim(mem);
  }

  /**
   * Record a social interaction between two agents.
   */
  recordInteraction(
    agentId: number, agentName: string,
    targetId: number, targetName: string,
    interactionType: string, // 'liked_by', 'commented_by', 'followed_by', etc.
    sentiment: number = 0, // positive interaction = +0.1, negative = -0.1
  ): void {
    const mem = this.getOrCreate(agentId, agentName);

    let rel = mem.relationships.get(targetId);
    if (!rel) {
      rel = {
        targetId,
        targetName,
        sentiment: 0,
        interactions: 0,
        lastInteraction: new Date().toISOString(),
        notes: [],
      };
      mem.relationships.set(targetId, rel);
    }

    rel.interactions++;
    rel.sentiment = Math.max(-1, Math.min(1, rel.sentiment + sentiment));
    rel.lastInteraction = new Date().toISOString();
    rel.notes.push(interactionType);
    if (rel.notes.length > 10) rel.notes = rel.notes.slice(-10);

    // Also add episodic memory
    mem.entries.push({
      round: -1, // will be set by caller
      type: 'social',
      content: `${targetName} ${interactionType}`,
      importance: 0.6,
      timestamp: new Date().toISOString(),
    });
    this.trim(mem);
  }

  /**
   * Record a learned fact or formed opinion.
   */
  recordInsight(agentId: number, agentName: string, insight: string, importance = 0.7): void {
    const mem = this.getOrCreate(agentId, agentName);
    mem.entries.push({
      round: -1,
      type: 'semantic',
      content: insight,
      importance,
      timestamp: new Date().toISOString(),
    });
    this.trim(mem);
  }

  /**
   * Build the raw (uncompressed) memory text for an agent.
   * This is the full-fidelity version used as input to LLM compression.
   */
  private buildRawSummary(mem: AgentMemoryState): string {
    const parts: string[] = [];

    // All entries sorted by round then importance
    const entries = [...mem.entries]
      .sort((a, b) => a.round - b.round || b.importance - a.importance);

    if (entries.length > 0) {
      parts.push('Memory entries:');
      for (const e of entries) {
        const tag = e.round >= 0 ? `[R${e.round}]` : '';
        parts.push(`- ${tag}(${e.type}) ${e.content}`);
      }
    }

    // Key relationships
    const rels = Array.from(mem.relationships.values())
      .sort((a, b) => b.interactions - a.interactions)
      .slice(0, 8);

    if (rels.length > 0) {
      parts.push('');
      parts.push('Relationships:');
      for (const r of rels) {
        const feeling = r.sentiment > 0.3 ? '(positive)'
          : r.sentiment < -0.3 ? '(negative)'
          : '(neutral)';
        parts.push(`- ${r.targetName}: ${r.interactions} interactions ${feeling}, recent: ${r.notes.slice(-3).join(', ')}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Generate a memory summary for injection into an agent's prompt.
   * Returns a concise text that captures what the agent remembers.
   *
   * Synchronous fast path: returns cached compressed summary if available,
   * otherwise falls back to raw summary with token limit.
   */
  getMemorySummary(agentId: number, maxTokens = 500): string {
    const mem = this.memories.get(agentId);
    if (!mem || (mem.entries.length === 0 && mem.relationships.size === 0)) {
      return '';
    }

    // Use compressed summary if fresh enough
    if (mem.compressedSummary && mem.compressedAtCount === mem.entries.length) {
      return mem.compressedSummary;
    }

    // Fallback: raw summary with hard token limit
    const raw = this.buildRawSummary(mem);
    const estimatedTokens = raw.length / 2;
    if (estimatedTokens > maxTokens) {
      return raw.slice(0, maxTokens * 2) + '\n...';
    }
    return raw;
  }

  /**
   * Compress all agent memories using LLM.
   * Call this once per round (or every N rounds) — it's async and batched.
   * After this call, getMemorySummary() will return compressed versions.
   */
  async compressMemories(options?: {
    /** Only compress if entries changed since last compression */
    onlyIfDirty?: boolean;
    /** Target summary length in chars (default: 600) */
    targetLength?: number;
  }): Promise<number> {
    const onlyIfDirty = options?.onlyIfDirty ?? true;
    const targetLength = options?.targetLength ?? 600;
    const llm = getDefaultLLMClient();
    let compressed = 0;

    const tasks: Promise<void>[] = [];

    for (const [id, mem] of this.memories) {
      // Skip if nothing changed since last compression
      if (onlyIfDirty && mem.compressedAtCount === mem.entries.length) {
        continue;
      }

      const raw = this.buildRawSummary(mem);
      // Skip if raw is already short enough
      if (raw.length <= targetLength) {
        mem.compressedSummary = raw;
        mem.compressedAtCount = mem.entries.length;
        continue;
      }

      tasks.push((async () => {
        try {
          const result = await llm.complete(
            COMPRESS_SYSTEM_PROMPT,
            `Agent: ${mem.agentName}\nTarget length: ~${targetLength} chars\n\nFull memory:\n${raw}`,
            { temperature: 0.2, maxTokens: 1024 },
          );
          mem.compressedSummary = result;
          mem.compressedAtCount = mem.entries.length;
          compressed++;
        } catch (e) {
          // Compression failed — keep using raw fallback, no crash
          console.error(`[memory] Failed to compress memory for ${mem.agentName}:`, e);
        }
      })());
    }

    await Promise.all(tasks);
    return compressed;
  }

  /**
   * Process a round's DB changes and update all agent memories.
   * Called after each env.step().
   */
  processRound(round: number, db: {
    newPosts: Array<{ postId: number; userId: number; content: string }>;
    newComments: Array<{ commentId: number; postId: number; userId: number; content: string; postAuthor: number }>;
    newLikes: Array<{ userId: number; postId: number; postAuthor: number }>;
    newFollows: Array<{ followerId: number; followeeId: number }>;
  }, agentNames: Map<number, string>): void {
    const getName = (id: number) => agentNames.get(id) ?? `agent_${id}`;

    // Posts → episodic memory for the author (store full content)
    for (const p of db.newPosts) {
      this.recordAction(p.userId, getName(p.userId), round,
        `I posted: "${p.content}"`, 0.7);
    }

    // Comments → memory for both author and post owner (store full content)
    for (const c of db.newComments) {
      this.recordAction(c.userId, getName(c.userId), round,
        `I commented on ${getName(c.postAuthor)}'s post: "${c.content}"`, 0.6);
      this.recordInteraction(c.postAuthor, getName(c.postAuthor),
        c.userId, getName(c.userId), 'commented on my post', 0.1);
    }

    // Likes → memory for post owner
    for (const l of db.newLikes) {
      this.recordInteraction(l.postAuthor, getName(l.postAuthor),
        l.userId, getName(l.userId), 'liked my post', 0.05);
    }

    // Follows → memory for both
    for (const f of db.newFollows) {
      this.recordInteraction(f.followeeId, getName(f.followeeId),
        f.followerId, getName(f.followerId), 'followed me', 0.15);
      this.recordAction(f.followerId, getName(f.followerId), round,
        `I followed ${getName(f.followeeId)}`, 0.4);
    }

    // Save periodically
    if (this.savePath && round % 3 === 0) {
      this.save();
    }
  }

  /**
   * Get all memory summaries for injection into Python bridge.
   * Returns a map of agentId → memory summary text.
   */
  getAllSummaries(): Map<number, string> {
    const result = new Map<number, string>();
    for (const [id, _] of this.memories) {
      const summary = this.getMemorySummary(id);
      if (summary) result.set(id, summary);
    }
    return result;
  }

  // ─── Persistence ──────────────────────────────────────────

  save(): void {
    if (!this.savePath) return;
    mkdirSync(join(this.savePath, '..'), { recursive: true });
    const data: Record<string, any> = {};
    for (const [id, mem] of this.memories) {
      data[id] = {
        agentId: mem.agentId,
        agentName: mem.agentName,
        entries: mem.entries,
        relationships: Array.from(mem.relationships.entries()).map(([k, v]) => [k, v]),
        compressedSummary: mem.compressedSummary,
        compressedAtCount: mem.compressedAtCount,
      };
    }
    writeFileSync(this.savePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  load(): void {
    if (!this.savePath || !existsSync(this.savePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.savePath, 'utf-8'));
      for (const [id, mem] of Object.entries(data) as any[]) {
        const state: AgentMemoryState = {
          agentId: mem.agentId,
          agentName: mem.agentName,
          entries: mem.entries,
          relationships: new Map(mem.relationships),
          compressedSummary: mem.compressedSummary,
          compressedAtCount: mem.compressedAtCount,
        };
        this.memories.set(Number(id), state);
      }
    } catch { /* corrupt file, start fresh */ }
  }

  // ─── Internal ─────────────────────────────────────────────

  private getOrCreate(agentId: number, agentName: string): AgentMemoryState {
    let mem = this.memories.get(agentId);
    if (!mem) {
      mem = { agentId, agentName, entries: [], relationships: new Map() };
      this.memories.set(agentId, mem);
    }
    return mem;
  }

  private trim(mem: AgentMemoryState): void {
    if (mem.entries.length > this.maxEntriesPerAgent) {
      // Keep most important entries
      mem.entries.sort((a, b) => b.importance - a.importance);
      mem.entries = mem.entries.slice(0, this.maxEntriesPerAgent);
      // Re-sort by time
      mem.entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }
  }
}

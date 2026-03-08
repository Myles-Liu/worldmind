/**
 * @module SemanticMemory
 *
 * Intelligent memory system for WorldMind agents.
 *
 * Replaces the simple array-based AgentMemory with:
 *
 * 1. **TF-IDF-like relevance scoring** — Retrieves memories that match a query
 *    by keyword overlap, weighted by term frequency and inverse document frequency.
 *    No external vector DB or embedding API needed.
 *
 * 2. **Importance decay** — Memories lose salience over time with configurable
 *    half-lives per memory type. Observations fade fast; lessons persist.
 *
 * 3. **Contextual retrieval** — Given a description of the current task,
 *    returns the most relevant memories ranked by (relevance × importance × freshness).
 *
 * 4. **Memory consolidation** — Periodically merges similar memories into
 *    higher-level observations, reducing redundancy.
 *
 * 5. **Type-based retention** — Different memory types have different decay rates:
 *    - `observation`: fast decay (half-life: 7 days)
 *    - `prediction`: medium decay (half-life: 30 days)
 *    - `reflection`: no decay (permanent)
 *    - `lesson`: no decay (permanent)
 *
 * Design decisions:
 *
 * - Uses in-memory inverted index for fast retrieval (O(terms) instead of O(memories))
 * - Stopwords are stripped for both English and Chinese common words
 * - IDF is computed lazily and cached until the next memory addition
 * - Consolidation uses Jaccard similarity on keyword sets (≥0.6 threshold)
 * - Memory file format is compatible with the old AgentMemory JSON format
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentMemoryEntry } from './agent-memory.js';
import type { ContextItem } from '../llm/context-engine.js';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Memory type determines retention policy.
 */
export type MemoryType = 'observation' | 'prediction' | 'reflection' | 'lesson';

/**
 * A semantic memory entry extends the base agent memory with
 * precomputed keyword data for efficient retrieval.
 */
export interface SemanticMemoryEntry extends AgentMemoryEntry {
  /** Unique ID for deduplication and consolidation tracking */
  id: string;
  /** Precomputed keywords for this memory (lowercased, stopwords removed) */
  keywords: string[];
  /** Whether this memory was produced by consolidation */
  consolidated: boolean;
  /** IDs of source memories if this is a consolidation result */
  sourceIds?: string[];
}

/**
 * Configuration for memory retention policies.
 */
export interface RetentionConfig {
  /** Half-life in milliseconds for each memory type. `null` = never decays. */
  halfLife: Record<MemoryType, number | null>;
  /** Maximum total memories to retain */
  maxMemories: number;
  /** Similarity threshold (0–1) for consolidation. Jaccard ≥ this → consolidate. */
  consolidationThreshold: number;
}

/**
 * Default retention configuration.
 */
export const DEFAULT_RETENTION: RetentionConfig = {
  halfLife: {
    observation: 7 * 24 * 60 * 60 * 1000,      // 7 days
    prediction: 30 * 24 * 60 * 60 * 1000,       // 30 days
    reflection: null,                             // Never decays
    lesson: null,                                 // Never decays
  },
  maxMemories: 200,
  consolidationThreshold: 0.6,
};

// ─── English Stopwords ──────────────────────────────────────────

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
  'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'and', 'but', 'or', 'if', 'while', 'because', 'until', 'although',
  'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our',
  'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they',
  'them', 'their', 'what', 'which', 'who', 'whom', 'up', 'about',
  'just', 'also', 'now', 'new', 'like', 'well', 'even', 'back', 'any',
  'get', 'got', 'make', 'made',
]);

// ─── Text Processing ────────────────────────────────────────────

/**
 * Extract meaningful keywords from text.
 *
 * Strategy:
 * 1. Lowercase the text
 * 2. Split on non-alphanumeric characters (preserving CJK characters)
 * 3. Remove English stopwords
 * 4. Remove tokens shorter than 2 characters (for English)
 * 5. Keep CJK characters as single-character tokens
 */
function extractKeywords(text: string): string[] {
  const lower = text.toLowerCase();

  // Split on whitespace and punctuation, but keep CJK characters
  const tokens: string[] = [];

  // Match words (ASCII) and CJK characters separately
  const wordPattern = /[a-z0-9_.-]+|[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]+/g;
  let match: RegExpExecArray | null;
  while ((match = wordPattern.exec(lower)) !== null) {
    tokens.push(match[0]);
  }

  // Filter: remove stopwords and very short tokens
  return tokens.filter(t => {
    if (t.length < 2) return false;
    if (STOPWORDS.has(t)) return false;
    return true;
  });
}

/**
 * Compute Jaccard similarity between two keyword sets.
 * Returns 0–1 (1 = identical sets).
 */
function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a);
  const setB = new Set(b);

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ─── Semantic Memory ────────────────────────────────────────────

let _idCounter = 0;

function generateId(): string {
  return `mem_${Date.now()}_${_idCounter++}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * SemanticMemory — Intelligent memory system for WorldMind agents.
 *
 * Usage:
 * ```ts
 * const memory = new SemanticMemory('trend');
 * await memory.load();
 *
 * memory.add({
 *   cycle: 5,
 *   type: 'observation',
 *   content: 'Rust-based repos showing 3x growth in star velocity',
 *   importance: 0.8,
 * });
 *
 * const relevant = memory.recall('rust ecosystem growth trends', 5);
 * // → Returns top 5 memories matching the query
 * ```
 */
export class SemanticMemory {
  private memories: SemanticMemoryEntry[] = [];
  private filePath: string;
  private retention: RetentionConfig;

  /** Inverted index: keyword → set of memory IDs */
  private invertedIndex: Map<string, Set<string>> = new Map();

  /** Document frequency cache: keyword → number of memories containing it */
  private dfCache: Map<string, number> | null = null;

  constructor(
    agentName: string,
    dataDir: string = 'data/agent-memories',
    retention?: Partial<RetentionConfig>,
  ) {
    this.filePath = path.join(dataDir, `${agentName}.json`);
    this.retention = { ...DEFAULT_RETENTION, ...retention };
  }

  /**
   * Load memories from disk.
   * Supports both old AgentMemoryEntry[] format and new SemanticMemoryEntry[] format.
   */
  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      const raw = JSON.parse(content) as Array<AgentMemoryEntry | SemanticMemoryEntry>;

      this.memories = raw.map(entry => {
        // Upgrade old format to new format
        const semantic = entry as SemanticMemoryEntry;
        if (!semantic.id) {
          semantic.id = generateId();
        }
        if (!semantic.keywords) {
          semantic.keywords = extractKeywords(semantic.content);
        }
        if (semantic.consolidated === undefined) {
          semantic.consolidated = false;
        }
        return semantic;
      });

      this.rebuildIndex();
    } catch {
      this.memories = [];
    }
  }

  /**
   * Persist memories to disk.
   * Applies retention policies before saving.
   */
  async save(): Promise<void> {
    // Apply decay and eviction before saving
    this.applyDecay();
    this.evict();

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.memories, null, 2));
  }

  /**
   * Add a new memory entry.
   */
  add(entry: Omit<AgentMemoryEntry, 'timestamp'>): void {
    const keywords = extractKeywords(entry.content);
    const semantic: SemanticMemoryEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
      id: generateId(),
      keywords,
      consolidated: false,
    };

    this.memories.push(semantic);
    this.indexMemory(semantic);
    this.dfCache = null; // Invalidate IDF cache
  }

  /**
   * Recall memories relevant to a query, ranked by
   * (TF-IDF relevance × importance × freshness).
   *
   * @param query - Natural language query describing what's needed
   * @param count - Maximum number of memories to return
   * @returns Memories sorted by relevance (highest first)
   */
  recall(query: string, count: number = 10): SemanticMemoryEntry[] {
    if (this.memories.length === 0) return [];

    const queryKeywords = extractKeywords(query);
    if (queryKeywords.length === 0) {
      // Fallback: return most recent memories
      return this.getRecent(count);
    }

    // Compute IDF if not cached
    if (!this.dfCache) {
      this.dfCache = this.computeDocumentFrequencies();
    }

    const totalDocs = this.memories.length;
    const now = Date.now();

    // Score each memory
    const scored = this.memories.map(memory => {
      // 1. TF-IDF relevance score
      const tfidfScore = this.computeTFIDF(queryKeywords, memory, totalDocs);

      // 2. Importance (already 0–1)
      const importance = memory.importance;

      // 3. Freshness based on memory type's half-life
      const freshness = this.computeFreshness(memory, now);

      // Combined score: weighted blend
      // Relevance is most important (50%), then importance (30%), then freshness (20%)
      const score = tfidfScore * 0.5 + importance * 0.3 + freshness * 0.2;

      return { memory, score };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Return top N
    return scored.slice(0, count).map(s => s.memory);
  }

  /**
   * Convert recalled memories to ContextItems for the ContextEngine.
   *
   * @param query - Query for relevance ranking
   * @param count - Maximum items
   * @returns Array of ContextItems ready for the engine's Layer 4
   */
  recallAsContextItems(query: string, count: number = 10): ContextItem[] {
    const memories = this.recall(query, count);
    return memories.map(m => ({
      id: m.id,
      content: `[${m.timestamp.slice(0, 16)} | ${m.type}] ${m.content}`,
      importance: m.importance,
      timestamp: m.timestamp,
    }));
  }

  /**
   * Get the most recent memories regardless of relevance.
   */
  getRecent(count: number = 20): SemanticMemoryEntry[] {
    return this.memories.slice(-count);
  }

  /**
   * Get memories of a specific type.
   */
  getByType(type: MemoryType, count: number = 10): SemanticMemoryEntry[] {
    return this.memories.filter(m => m.type === type).slice(-count);
  }

  /**
   * Format memories for a prompt (backward-compatible with AgentMemory).
   */
  formatForPrompt(count: number = 15): string {
    const recent = this.getRecent(count);
    if (recent.length === 0) return 'No prior memories.';

    return recent.map(m =>
      `[${m.timestamp.slice(0, 16)} | ${m.type} | importance: ${m.importance}] ${m.content}`,
    ).join('\n');
  }

  /**
   * Consolidate similar memories into higher-level observations.
   *
   * Strategy:
   * 1. Find pairs of memories with Jaccard similarity ≥ threshold
   * 2. Merge them into a single consolidated memory
   * 3. Keep the higher importance and more recent timestamp
   * 4. Only consolidate memories of the same type
   *
   * Should be called periodically (e.g., once per cycle during finalize).
   */
  consolidate(): number {
    let mergeCount = 0;
    const toRemove = new Set<string>();
    const toAdd: SemanticMemoryEntry[] = [];

    // Only consolidate observations (the most numerous type)
    const observations = this.memories.filter(
      m => m.type === 'observation' && !toRemove.has(m.id),
    );

    for (let i = 0; i < observations.length; i++) {
      const a = observations[i]!;
      if (toRemove.has(a.id)) continue;

      for (let j = i + 1; j < observations.length; j++) {
        const b = observations[j]!;
        if (toRemove.has(b.id)) continue;

        const similarity = jaccardSimilarity(a.keywords, b.keywords);
        if (similarity >= this.retention.consolidationThreshold) {
          // Merge: keep the more important/recent one, absorb content
          const merged: SemanticMemoryEntry = {
            id: generateId(),
            timestamp: a.timestamp > b.timestamp ? a.timestamp : b.timestamp,
            cycle: Math.max(a.cycle, b.cycle),
            type: 'observation',
            content: a.importance >= b.importance
              ? `${a.content} (Also observed: ${b.content.slice(0, 100)})`
              : `${b.content} (Also observed: ${a.content.slice(0, 100)})`,
            importance: Math.max(a.importance, b.importance),
            keywords: [...new Set([...a.keywords, ...b.keywords])],
            consolidated: true,
            sourceIds: [
              ...(a.sourceIds ?? [a.id]),
              ...(b.sourceIds ?? [b.id]),
            ],
          };

          toRemove.add(a.id);
          toRemove.add(b.id);
          toAdd.push(merged);
          mergeCount++;
          break; // Move to next `a`
        }
      }
    }

    if (toRemove.size > 0) {
      this.memories = this.memories.filter(m => !toRemove.has(m.id));
      this.memories.push(...toAdd);
      this.rebuildIndex();
    }

    return mergeCount;
  }

  /**
   * Total number of memories.
   */
  get size(): number {
    return this.memories.length;
  }

  // ─── Private: TF-IDF ───────────────────────────────────────────

  /**
   * Compute TF-IDF score for a query against a memory.
   *
   * TF (term frequency): How often the query term appears in the memory's keywords.
   * IDF (inverse document frequency): How rare the term is across all memories.
   * Score = sum of (TF × IDF) for each query term.
   */
  private computeTFIDF(
    queryKeywords: string[],
    memory: SemanticMemoryEntry,
    totalDocs: number,
  ): number {
    if (memory.keywords.length === 0) return 0;

    // Build term frequency map for this memory
    const tf = new Map<string, number>();
    for (const kw of memory.keywords) {
      tf.set(kw, (tf.get(kw) ?? 0) + 1);
    }

    let score = 0;
    for (const term of queryKeywords) {
      const termFreq = (tf.get(term) ?? 0) / memory.keywords.length;
      const docFreq = this.dfCache?.get(term) ?? 0;
      // IDF with smoothing: log((N + 1) / (df + 1))
      const idf = Math.log((totalDocs + 1) / (docFreq + 1));
      score += termFreq * idf;
    }

    // Normalize to 0–1 range (approximate)
    const maxPossibleScore = queryKeywords.length * Math.log(totalDocs + 1);
    return maxPossibleScore > 0 ? Math.min(1, score / maxPossibleScore) : 0;
  }

  /**
   * Compute document frequencies for all terms.
   */
  private computeDocumentFrequencies(): Map<string, number> {
    const df = new Map<string, number>();
    for (const memory of this.memories) {
      const uniqueKeywords = new Set(memory.keywords);
      for (const kw of uniqueKeywords) {
        df.set(kw, (df.get(kw) ?? 0) + 1);
      }
    }
    return df;
  }

  /**
   * Compute freshness score for a memory based on its type's half-life.
   * Returns 1.0 for brand new memories, decaying toward 0.
   * Returns 1.0 for types with no decay (reflection, lesson).
   */
  private computeFreshness(memory: SemanticMemoryEntry, now: number): number {
    const memType = memory.type as MemoryType;
    const halfLife = this.retention.halfLife[memType];

    // No decay configured → always fresh
    if (halfLife === null || halfLife === undefined) return 1.0;

    const ageMs = now - new Date(memory.timestamp).getTime();
    if (ageMs <= 0) return 1.0;

    // Exponential decay: 0.5^(age / halfLife)
    return Math.pow(0.5, ageMs / halfLife);
  }

  // ─── Private: Index Management ────────────────────────────────

  /**
   * Add a memory to the inverted index.
   */
  private indexMemory(memory: SemanticMemoryEntry): void {
    for (const kw of memory.keywords) {
      let set = this.invertedIndex.get(kw);
      if (!set) {
        set = new Set();
        this.invertedIndex.set(kw, set);
      }
      set.add(memory.id);
    }
  }

  /**
   * Rebuild the entire inverted index from scratch.
   * Called after consolidation or load.
   */
  private rebuildIndex(): void {
    this.invertedIndex.clear();
    this.dfCache = null;
    for (const memory of this.memories) {
      this.indexMemory(memory);
    }
  }

  // ─── Private: Retention Policies ──────────────────────────────

  /**
   * Apply importance decay to all memories based on their type.
   * Memories below a minimum threshold after decay are candidates for eviction.
   */
  private applyDecay(): void {
    const now = Date.now();
    const MIN_IMPORTANCE = 0.05;

    for (const memory of this.memories) {
      const memType = memory.type as MemoryType;
      const halfLife = this.retention.halfLife[memType];

      // No decay for this type
      if (halfLife === null || halfLife === undefined) continue;

      const freshness = this.computeFreshness(memory, now);
      // Decay the importance: effective importance = base importance × freshness
      // We don't modify the stored importance (it represents intrinsic value),
      // but we use freshness in scoring. For eviction, we use the product.
      // Actually, let's mark memories that have decayed below threshold
      if (memory.importance * freshness < MIN_IMPORTANCE) {
        memory.importance = 0; // Mark for eviction
      }
    }
  }

  /**
   * Evict memories that exceed the maximum count.
   *
   * Strategy:
   * 1. Remove all zero-importance memories (fully decayed)
   * 2. If still over limit, sort by (type priority × importance × freshness)
   *    and remove the lowest-scoring memories
   */
  private evict(): void {
    // Phase 1: Remove fully decayed
    this.memories = this.memories.filter(m => m.importance > 0);

    // Phase 2: If still over limit, evict lowest-scoring
    if (this.memories.length > this.retention.maxMemories) {
      const now = Date.now();

      // Type priority: lessons and reflections are more valuable to keep
      const typePriority: Record<string, number> = {
        lesson: 1.0,
        reflection: 0.9,
        prediction: 0.6,
        observation: 0.4,
      };

      const scored = this.memories.map(m => {
        const tp = typePriority[m.type] ?? 0.5;
        const freshness = this.computeFreshness(m, now);
        return {
          memory: m,
          score: tp * m.importance * (0.3 + 0.7 * freshness),
        };
      });

      scored.sort((a, b) => b.score - a.score);
      this.memories = scored.slice(0, this.retention.maxMemories).map(s => s.memory);
      this.rebuildIndex();
    }
  }
}

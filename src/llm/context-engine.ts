/**
 * @module ContextEngine
 *
 * Layered context composition engine for WorldMind agents.
 *
 * Replaces the simple priority-based ContextComposer with a sophisticated
 * 5-layer architecture that mirrors how the best AI agents manage context:
 *
 *   Layer 1 — Identity:      Always present, never compressed
 *   Layer 2 — World State:   High priority, summarized under pressure
 *   Layer 3 — Working Memory: Dynamic, task-specific content
 *   Layer 4 — Long-term Memory: Retrieved on demand via relevance
 *   Layer 5 — Knowledge:     Injected based on topic relevance
 *
 * Key design decisions:
 *
 * 1. **Layered budgets with dynamic reallocation** — Each layer has a base
 *    budget, but unused tokens flow to subsequent layers. This prevents waste
 *    when an agent has sparse identity but rich working memory.
 *
 * 2. **Compression strategies per layer** — Identity is never compressed,
 *    world state gets summarized, working memory gets semantically selected,
 *    and knowledge gets truncated as a last resort.
 *
 * 3. **Mixed-language token estimation** — English (~4 chars/token) and
 *    Chinese (~1.5 chars/token) are weighted separately via character
 *    classification, with a formatting overhead factor for JSON/markdown.
 *
 * 4. **Graceful degradation** — Under extreme token pressure, the engine
 *    progressively drops lower-priority layers rather than producing an
 *    incoherent prompt. It always preserves Layer 1.
 */

// ─── Types ──────────────────────────────────────────────────────

/**
 * Compression strategy for a context layer.
 *
 * - `none`:            Include verbatim; never compress.
 * - `truncate`:        Cut from the end when over budget.
 * - `summarize`:       Use bullet-point condensation (no LLM call — pure heuristic).
 * - `semantic-select`: Pick the most relevant items by freshness × importance.
 */
export type CompressionStrategy = 'none' | 'truncate' | 'summarize' | 'semantic-select';

/**
 * A single item within a context layer.
 * Items are the atomic units of context — individual memories, events,
 * knowledge entries, etc.
 */
export interface ContextItem {
  /** Unique identifier for deduplication */
  id: string;
  /** The text content */
  content: string;
  /** Importance score 0–1 (higher = more important) */
  importance: number;
  /** ISO 8601 timestamp for freshness scoring */
  timestamp?: string;
  /** Optional metadata for debugging */
  metadata?: Record<string, unknown>;
}

/**
 * Configuration for a single context layer.
 */
export interface ContextLayerConfig {
  /** Layer name (used as section header in the composed prompt) */
  name: string;
  /** Layer number 1–5 (determines base priority) */
  layer: 1 | 2 | 3 | 4 | 5;
  /** Maximum token budget for this layer (before reallocation) */
  budgetTokens: number;
  /** Compression strategy when content exceeds budget */
  compressor: CompressionStrategy;
  /**
   * Freshness weight 0–1.
   * At 1.0, the most recent item gets full weight and older items decay.
   * At 0.0, all items are weighted equally regardless of age.
   */
  freshnessWeight: number;
  /** If true, this layer is always included even under extreme pressure */
  required: boolean;
}

/**
 * A fully populated context layer ready for composition.
 */
export interface ContextLayer {
  config: ContextLayerConfig;
  items: ContextItem[];
}

/**
 * Token usage report for a composed prompt.
 */
export interface TokenUsageReport {
  totalTokens: number;
  budgetTokens: number;
  layerBreakdown: Array<{
    name: string;
    layer: number;
    tokensUsed: number;
    budgetTokens: number;
    itemCount: number;
    compressed: boolean;
  }>;
  overflow: boolean;
}

// ─── Token Estimation ───────────────────────────────────────────

/**
 * Estimate the number of tokens in a string.
 *
 * Uses character classification to handle mixed-language text:
 * - CJK characters: ~1.5 chars per token (Chinese/Japanese/Korean)
 * - ASCII/Latin: ~4 chars per token (English and code)
 * - Formatting overhead: +5% for markdown/JSON structure
 *
 * This is intentionally conservative (overestimates slightly) to avoid
 * exceeding the actual token limit at the LLM API boundary.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let cjkChars = 0;
  let otherChars = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // CJK Unified Ideographs, CJK Extensions, Hiragana, Katakana, Hangul
    if (
      (code >= 0x4E00 && code <= 0x9FFF) ||   // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4DBF) ||   // CJK Extension A
      (code >= 0x3040 && code <= 0x309F) ||   // Hiragana
      (code >= 0x30A0 && code <= 0x30FF) ||   // Katakana
      (code >= 0xAC00 && code <= 0xD7AF) ||   // Hangul Syllables
      (code >= 0xF900 && code <= 0xFAFF)      // CJK Compatibility Ideographs
    ) {
      cjkChars++;
    } else {
      otherChars++;
    }
  }

  const cjkTokens = cjkChars / 1.5;
  const otherTokens = otherChars / 4;
  const rawTokens = cjkTokens + otherTokens;

  // Add 5% overhead for markdown/JSON formatting artifacts
  return Math.ceil(rawTokens * 1.05);
}

// ─── Compression Helpers ────────────────────────────────────────

/**
 * Truncate text to fit within a token budget.
 * Tries to break at paragraph/line boundaries for cleaner output.
 */
function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;

  // Approximate max chars — use the more aggressive ratio (4 chars/token)
  // to ensure we don't over-truncate
  const maxChars = maxTokens * 3;
  if (text.length <= maxChars) return text;

  // Try to truncate at a paragraph boundary
  const truncated = text.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf('\n');
  const breakPoint = lastNewline > maxChars * 0.7 ? lastNewline : maxChars;

  return text.slice(0, breakPoint) + '\n… [truncated]';
}

/**
 * Heuristic summarization: extract the most information-dense sentences.
 *
 * Strategy:
 * 1. Split into sentences/lines
 * 2. Score each by information density (unique words / total words)
 * 3. Keep top sentences that fit within budget
 * 4. Preserve original order
 *
 * This is NOT LLM-based — it's a fast, deterministic heuristic.
 */
function summarizeToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;

  // Split into meaningful chunks (paragraphs or lines)
  const chunks = text.split(/\n+/).filter(line => line.trim().length > 0);
  if (chunks.length <= 1) return truncateToTokens(text, maxTokens);

  // Score each chunk by information density
  const scored = chunks.map((chunk, index) => {
    const words = chunk.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const uniqueWords = new Set(words);
    // Density = unique meaningful words / total words (higher = more info-dense)
    const density = words.length > 0 ? uniqueWords.size / words.length : 0;
    // Bonus for containing key indicator words
    const hasKeywords = /trend|predict|grow|declin|emerg|shift|signal|notable|important|significant/i.test(chunk) ? 0.2 : 0;
    return { chunk, index, score: density + hasKeywords, tokens: estimateTokens(chunk) };
  });

  // Sort by score (descending), but we'll restore original order
  const sorted = [...scored].sort((a, b) => b.score - a.score);

  // Greedily pick chunks within budget
  const selected: typeof scored = [];
  let usedTokens = 0;
  const headerTokens = estimateTokens('[Summary]\n');

  for (const item of sorted) {
    if (usedTokens + item.tokens + headerTokens > maxTokens) continue;
    selected.push(item);
    usedTokens += item.tokens;
  }

  // If nothing fits, fall back to truncation
  if (selected.length === 0) return truncateToTokens(text, maxTokens);

  // Restore original order
  selected.sort((a, b) => a.index - b.index);

  return selected.map(s => s.chunk).join('\n');
}

/**
 * Semantic selection: pick the most relevant items based on
 * importance × freshness scoring.
 *
 * @param items   - Candidate items to select from
 * @param maxTokens - Token budget
 * @param freshnessWeight - How much recency matters (0 = not at all, 1 = dominates)
 * @returns Selected items that fit within budget, in their original order
 */
function semanticSelect(
  items: ContextItem[],
  maxTokens: number,
  freshnessWeight: number,
): ContextItem[] {
  if (items.length === 0) return [];

  const now = Date.now();

  // Score each item
  const scored = items.map((item, originalIndex) => {
    // Freshness score: exponential decay with 7-day half-life
    let freshnessScore = 1.0;
    if (item.timestamp && freshnessWeight > 0) {
      const ageMs = now - new Date(item.timestamp).getTime();
      const halfLifeMs = 7 * 24 * 60 * 60 * 1000; // 7 days
      freshnessScore = Math.exp(-0.693 * ageMs / halfLifeMs); // ln(2) ≈ 0.693
    }

    // Combined score: weighted blend of importance and freshness
    const score = item.importance * (1 - freshnessWeight) + freshnessScore * freshnessWeight;
    const tokens = estimateTokens(item.content);

    return { item, originalIndex, score, tokens };
  });

  // Sort by combined score (descending)
  scored.sort((a, b) => b.score - a.score);

  // Greedily select items within budget
  const selected: typeof scored = [];
  let usedTokens = 0;

  for (const entry of scored) {
    if (usedTokens + entry.tokens > maxTokens) {
      // Try to fit a truncated version if this item is important enough
      if (entry.score > 0.5) {
        const remaining = maxTokens - usedTokens;
        if (remaining > 50) { // At least 50 tokens to be useful
          const truncated = truncateToTokens(entry.item.content, remaining);
          selected.push({
            ...entry,
            item: { ...entry.item, content: truncated },
            tokens: remaining,
          });
          usedTokens += remaining;
        }
      }
      continue;
    }
    selected.push(entry);
    usedTokens += entry.tokens;
  }

  // Restore original order for coherence
  selected.sort((a, b) => a.originalIndex - b.originalIndex);

  return selected.map(s => s.item);
}

// ─── Context Engine ─────────────────────────────────────────────

/**
 * Default layer configurations for WorldMind agents.
 *
 * These provide sensible defaults that can be overridden per-agent.
 */
export const DEFAULT_LAYER_CONFIGS: ContextLayerConfig[] = [
  {
    name: 'Identity & Principles',
    layer: 1,
    budgetTokens: 800,
    compressor: 'none',
    freshnessWeight: 0,
    required: true,
  },
  {
    name: 'World State',
    layer: 2,
    budgetTokens: 600,
    compressor: 'summarize',
    freshnessWeight: 0.3,
    required: false,
  },
  {
    name: 'Working Memory',
    layer: 3,
    budgetTokens: 1200,
    compressor: 'semantic-select',
    freshnessWeight: 0.7,
    required: false,
  },
  {
    name: 'Long-term Memory',
    layer: 4,
    budgetTokens: 500,
    compressor: 'semantic-select',
    freshnessWeight: 0.5,
    required: false,
  },
  {
    name: 'Domain Knowledge',
    layer: 5,
    budgetTokens: 400,
    compressor: 'truncate',
    freshnessWeight: 0,
    required: false,
  },
];

/**
 * ContextEngine — Layered context composition for agent prompts.
 *
 * Usage:
 * ```ts
 * const engine = new ContextEngine(4000);
 * engine.setLayer({
 *   config: { name: 'Identity', layer: 1, ... },
 *   items: [{ id: 'soul', content: '...', importance: 1 }],
 * });
 * const { prompt, usage } = engine.compose();
 * ```
 */
export class ContextEngine {
  private totalBudget: number;
  private layers: Map<number, ContextLayer> = new Map();
  private layerConfigs: ContextLayerConfig[];

  /**
   * @param totalBudgetTokens - Maximum tokens for the composed system prompt
   * @param layerConfigs - Optional custom layer configurations (defaults to DEFAULT_LAYER_CONFIGS)
   */
  constructor(
    totalBudgetTokens: number = 4000,
    layerConfigs?: ContextLayerConfig[],
  ) {
    this.totalBudget = totalBudgetTokens;
    this.layerConfigs = layerConfigs ?? [...DEFAULT_LAYER_CONFIGS];
  }

  /**
   * Set the content for a specific layer.
   * Replaces any previously set content for that layer number.
   */
  setLayer(layer: ContextLayer): void {
    this.layers.set(layer.config.layer, layer);
  }

  /**
   * Convenience: set layer content from a single text string.
   * Creates a single ContextItem from the text.
   */
  setLayerText(layerNum: 1 | 2 | 3 | 4 | 5, content: string, importance: number = 1.0): void {
    const config = this.layerConfigs.find(c => c.layer === layerNum);
    if (!config) return;

    this.layers.set(layerNum, {
      config,
      items: content.trim() ? [{
        id: `${config.name}-single`,
        content: content.trim(),
        importance,
        timestamp: new Date().toISOString(),
      }] : [],
    });
  }

  /**
   * Set layer content from multiple items (e.g., memories, events).
   */
  setLayerItems(layerNum: 1 | 2 | 3 | 4 | 5, items: ContextItem[]): void {
    const config = this.layerConfigs.find(c => c.layer === layerNum);
    if (!config) return;

    this.layers.set(layerNum, { config, items });
  }

  /**
   * Compose all layers into a single system prompt string.
   *
   * Algorithm:
   * 1. Calculate effective budgets with dynamic reallocation
   * 2. Compress each layer according to its strategy
   * 3. Assemble final prompt with section headers
   * 4. Final safety truncation if still over budget
   *
   * @returns The composed prompt and a token usage report
   */
  compose(): { prompt: string; usage: TokenUsageReport } {
    // Phase 1: Calculate raw token needs per layer
    const layerSizes = new Map<number, number>();
    for (const [layerNum, layer] of this.layers) {
      const totalTokens = layer.items.reduce(
        (sum, item) => sum + estimateTokens(item.content),
        0,
      );
      layerSizes.set(layerNum, totalTokens);
    }

    // Phase 2: Dynamic budget reallocation
    // Layers that need less than their budget donate surplus to others
    const effectiveBudgets = this.reallocateBudgets(layerSizes);

    // Phase 3: Compress each layer
    const composedLayers: Array<{
      config: ContextLayerConfig;
      text: string;
      tokens: number;
      itemCount: number;
      compressed: boolean;
    }> = [];

    // Process layers in order (1 → 5)
    const sortedLayerNums = [...this.layers.keys()].sort((a, b) => a - b);

    for (const layerNum of sortedLayerNums) {
      const layer = this.layers.get(layerNum);
      if (!layer) continue;

      // Skip empty layers
      if (layer.items.length === 0 || layer.items.every(i => !i.content.trim())) {
        continue;
      }

      const budget = effectiveBudgets.get(layerNum) ?? layer.config.budgetTokens;
      const rawTokens = layerSizes.get(layerNum) ?? 0;
      const needsCompression = rawTokens > budget;

      let text: string;
      let itemCount: number;

      if (!needsCompression) {
        // Content fits — include everything
        text = layer.items.map(i => i.content).join('\n\n');
        itemCount = layer.items.length;
      } else {
        // Apply compression strategy
        switch (layer.config.compressor) {
          case 'none':
            // Never compress — include verbatim (may exceed budget)
            text = layer.items.map(i => i.content).join('\n\n');
            itemCount = layer.items.length;
            break;

          case 'truncate':
            text = truncateToTokens(
              layer.items.map(i => i.content).join('\n\n'),
              budget,
            );
            itemCount = layer.items.length;
            break;

          case 'summarize':
            text = summarizeToTokens(
              layer.items.map(i => i.content).join('\n\n'),
              budget,
            );
            itemCount = layer.items.length;
            break;

          case 'semantic-select': {
            const selected = semanticSelect(
              layer.items,
              budget,
              layer.config.freshnessWeight,
            );
            text = selected.map(i => i.content).join('\n\n');
            itemCount = selected.length;
            break;
          }

          default:
            text = truncateToTokens(
              layer.items.map(i => i.content).join('\n\n'),
              budget,
            );
            itemCount = layer.items.length;
        }
      }

      if (text.trim()) {
        composedLayers.push({
          config: layer.config,
          text: text.trim(),
          tokens: estimateTokens(text),
          itemCount,
          compressed: needsCompression,
        });
      }
    }

    // Phase 4: Final assembly with section headers
    // Calculate total tokens including section headers
    let totalUsed = 0;
    const sections: string[] = [];

    for (const cl of composedLayers) {
      const header = `## ${cl.config.name}`;
      const headerTokens = estimateTokens(header) + 2; // +2 for newlines
      const sectionTokens = cl.tokens + headerTokens;

      // If adding this section would exceed the total budget,
      // and it's not required, skip it
      if (totalUsed + sectionTokens > this.totalBudget && !cl.config.required) {
        // Try truncating this section to fit remaining space
        const remaining = this.totalBudget - totalUsed - headerTokens;
        if (remaining > 80) {
          const truncated = truncateToTokens(cl.text, remaining);
          sections.push(`${header}\n${truncated}`);
          totalUsed += headerTokens + estimateTokens(truncated);
        }
        // Stop adding more sections — budget exhausted
        break;
      }

      sections.push(`${header}\n${cl.text}`);
      totalUsed += sectionTokens;
    }

    const prompt = sections.join('\n\n');

    // Build usage report
    const usage: TokenUsageReport = {
      totalTokens: estimateTokens(prompt),
      budgetTokens: this.totalBudget,
      layerBreakdown: composedLayers.map(cl => ({
        name: cl.config.name,
        layer: cl.config.layer,
        tokensUsed: cl.tokens,
        budgetTokens: effectiveBudgets.get(cl.config.layer) ?? cl.config.budgetTokens,
        itemCount: cl.itemCount,
        compressed: cl.compressed,
      })),
      overflow: estimateTokens(prompt) > this.totalBudget,
    };

    return { prompt, usage };
  }

  /**
   * Reset all layers (useful between cycles).
   */
  clear(): void {
    this.layers.clear();
  }

  /**
   * Get the current total budget.
   */
  get budget(): number {
    return this.totalBudget;
  }

  /**
   * Update the total budget.
   */
  set budget(tokens: number) {
    this.totalBudget = tokens;
  }

  // ─── Private: Budget Reallocation ─────────────────────────────

  /**
   * Dynamically reallocate token budgets between layers.
   *
   * Strategy:
   * - Layers that need fewer tokens than their budget "donate" the surplus
   * - Surplus is distributed proportionally to layers that need more
   * - Required layers (Layer 1) keep their full budget minimum
   * - Donation is capped: a layer can receive at most 2× its base budget
   *
   * This prevents waste: if Identity only uses 200 of 800 tokens,
   * the remaining 600 flow to Working Memory or Long-term Memory.
   */
  private reallocateBudgets(layerSizes: Map<number, number>): Map<number, number> {
    const budgets = new Map<number, number>();
    let totalSurplus = 0;
    let totalDeficit = 0;

    // First pass: identify surplus and deficit layers
    const deficitLayers: Array<{ layerNum: number; deficit: number; baseBudget: number }> = [];

    for (const config of this.layerConfigs) {
      const layerNum = config.layer;
      const needed = layerSizes.get(layerNum) ?? 0;
      const baseBudget = config.budgetTokens;

      if (needed <= baseBudget) {
        // This layer has surplus — allocate only what it needs (with 10% padding)
        const allocated = needed === 0 ? 0 : Math.ceil(needed * 1.1);
        budgets.set(layerNum, Math.max(allocated, config.required ? baseBudget : allocated));
        totalSurplus += baseBudget - allocated;
      } else {
        // This layer has deficit
        budgets.set(layerNum, baseBudget);
        const deficit = needed - baseBudget;
        deficitLayers.push({ layerNum, deficit, baseBudget });
        totalDeficit += deficit;
      }
    }

    // Second pass: distribute surplus to deficit layers proportionally
    if (totalSurplus > 0 && deficitLayers.length > 0) {
      for (const { layerNum, deficit, baseBudget } of deficitLayers) {
        // Proportional share of surplus
        const share = totalDeficit > 0
          ? (deficit / totalDeficit) * totalSurplus
          : totalSurplus / deficitLayers.length;

        // Cap: no layer gets more than 2× its base budget
        const maxBudget = baseBudget * 2;
        const newBudget = Math.min(baseBudget + share, maxBudget);
        budgets.set(layerNum, Math.ceil(newBudget));
      }
    }

    return budgets;
  }
}

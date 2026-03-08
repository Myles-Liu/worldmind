export interface ContextSection {
  name: string;        // Section identifier (soul, memory, knowledge, task)
  content: string;     // The actual text
  priority: number;    // 0-1, higher = more important
  required: boolean;   // If true, always include
  maxTokens?: number;  // Max tokens for this section (approximate)
}

/**
 * @deprecated Use `ContextEngine` from `./context-engine.js` instead.
 *
 * ContextComposer is retained for backward compatibility but will be
 * removed in a future version. It only supports priority-based truncation
 * without semantic compression, dynamic budget reallocation, or layered
 * context management.
 *
 * Migration:
 * ```ts
 * // Old:
 * const composer = new ContextComposer(3500);
 * const prompt = composer.compose(sections);
 *
 * // New:
 * const engine = new ContextEngine(3500);
 * engine.setLayerText(1, soulContent);
 * engine.setLayerText(3, workingMemory);
 * const { prompt } = engine.compose();
 * ```
 */
export class ContextComposer {
  private maxTotalTokens: number;
  
  constructor(maxTotalTokens = 3500) {
    this.maxTotalTokens = maxTotalTokens;
  }

  /**
   * Compose a system prompt from multiple context sections,
   * respecting the token budget.
   * 
   * Strategy:
   * 1. Always include required sections
   * 2. Sort optional sections by priority
   * 3. Add optional sections until budget is exhausted
   * 4. If a section exceeds its maxTokens, truncate it
   */
  compose(sections: ContextSection[]): string {
    const required = sections.filter(s => s.required);
    const optional = sections
      .filter(s => !s.required)
      .sort((a, b) => b.priority - a.priority);
    
    let totalTokens = 0;
    const included: ContextSection[] = [];
    
    // Add required sections first
    for (const section of required) {
      const tokens = this.estimateTokens(section.content);
      const truncated = section.maxTokens 
        ? this.truncate(section.content, section.maxTokens)
        : section.content;
      included.push({ ...section, content: truncated });
      totalTokens += Math.min(tokens, section.maxTokens ?? tokens);
    }
    
    // Add optional sections by priority
    for (const section of optional) {
      const tokens = this.estimateTokens(section.content);
      const maxForSection = section.maxTokens ?? tokens;
      const effectiveTokens = Math.min(tokens, maxForSection);
      
      if (totalTokens + effectiveTokens > this.maxTotalTokens) {
        // Try to fit a truncated version
        const remaining = this.maxTotalTokens - totalTokens;
        if (remaining > 100) { // At least 100 tokens to be useful
          const truncated = this.truncate(section.content, remaining);
          included.push({ ...section, content: truncated });
          totalTokens += remaining;
        }
        break; // Budget exhausted
      }
      
      const truncated = section.maxTokens 
        ? this.truncate(section.content, section.maxTokens)
        : section.content;
      included.push({ ...section, content: truncated });
      totalTokens += effectiveTokens;
    }
    
    // Compose final prompt with clear section headers
    return included
      .map(s => `## ${s.name}\n${s.content}`)
      .join('\n\n');
  }
  
  /**
   * Rough token estimation (~4 chars per token for English, ~2 for Chinese).
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
  }
  
  /**
   * Truncate text to approximately maxTokens.
   */
  private truncate(text: string, maxTokens: number): string {
    const maxChars = maxTokens * 3.5;
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.floor(maxChars)) + '\n... [truncated]';
  }
}

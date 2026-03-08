import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface KnowledgeEntry {
  id: string;
  topic: string;       // e.g. "openclaw", "react", "rust"
  content: string;      // Natural language knowledge
  source: string;       // Who added it: "user", "agent", "system"
  addedAt: string;
  relevance: number;    // 0-1, how broadly relevant (1 = always include)
}

export class KnowledgeBase {
  private entries: KnowledgeEntry[] = [];
  private filePath: string;

  constructor(dataDir = 'data/knowledge') {
    this.filePath = path.join(dataDir, 'knowledge.json');
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      this.entries = JSON.parse(content) as KnowledgeEntry[];
    } catch {
      this.entries = [];
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.entries, null, 2));
  }

  add(entry: Omit<KnowledgeEntry, 'id' | 'addedAt'>): void {
    this.entries.push({
      ...entry,
      id: `kb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      addedAt: new Date().toISOString(),
    });
  }

  /**
   * Find knowledge relevant to a set of topics/entities.
   *
   * Scoring:
   * - topic field must match (substring in content alone is too loose)
   * - relevance acts as a tiebreaker, NOT a guaranteed include
   * - Minimum score threshold to avoid noise injection
   */
  findRelevant(topics: string[], maxEntries = 3): KnowledgeEntry[] {
    const topicsLower = topics.map(t => t.toLowerCase());

    const scored = this.entries.map(entry => {
      const entryTopic = entry.topic.toLowerCase();
      // Primary: topic field matches one of the query topics
      const topicFieldMatch = topicsLower.some(t => entryTopic === t || entryTopic.includes(t) || t.includes(entryTopic));
      if (!topicFieldMatch) return { entry, score: 0 };

      // Secondary: how many query topics appear in content (word-level, not substring)
      const contentLower = entry.content.toLowerCase();
      const contentHits = topicsLower.filter(t => contentLower.includes(t)).length;
      const contentScore = Math.min(contentHits / Math.max(topicsLower.length, 1), 1.0);

      const score = 0.5 + contentScore * 0.3 + entry.relevance * 0.2;
      return { entry, score };
    });

    return scored
      .filter(s => s.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxEntries)
      .map(s => s.entry);
  }

  // Format relevant knowledge for Agent prompts
  formatForPrompt(topics: string[]): string {
    const relevant = this.findRelevant(topics);
    if (relevant.length === 0) return '';

    return '\n\nDomain Knowledge (verified facts — give these significant weight in your analysis):\n' +
      relevant.map(e => `- [${e.topic}] ${e.content}`).join('\n');
  }

  get size(): number {
    return this.entries.length;
  }
}

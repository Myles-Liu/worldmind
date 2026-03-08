import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface AgentMemoryEntry {
  timestamp: string;
  cycle: number;
  type: string;        // 记忆类型：observation, prediction, reflection, lesson
  content: string;     // 自然语言描述
  data?: Record<string, unknown>;  // 结构化数据
  importance: number;  // 0-1
}

export class AgentMemory {
  private memories: AgentMemoryEntry[] = [];
  private filePath: string;
  private maxMemories: number;

  constructor(agentName: string, dataDir = 'data/agent-memories', maxMemories = 100) {
    this.filePath = path.join(dataDir, `${agentName}.json`);
    this.maxMemories = maxMemories;
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      this.memories = JSON.parse(content);
    } catch {
      this.memories = [];
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // Keep only the most recent/important memories
    if (this.memories.length > this.maxMemories) {
      // Sort by importance * recency, keep top N
      this.memories.sort((a, b) => {
        const recencyA = Date.now() - new Date(a.timestamp).getTime();
        const recencyB = Date.now() - new Date(b.timestamp).getTime();
        const scoreA = a.importance * (1 / (1 + recencyA / (30 * 24 * 60 * 60 * 1000))); // 30-day half-life
        const scoreB = b.importance * (1 / (1 + recencyB / (30 * 24 * 60 * 60 * 1000)));
        return scoreB - scoreA;
      });
      this.memories = this.memories.slice(0, this.maxMemories);
    }
    await fs.writeFile(this.filePath, JSON.stringify(this.memories, null, 2));
  }

  add(entry: Omit<AgentMemoryEntry, 'timestamp'>): void {
    this.memories.push({
      ...entry,
      timestamp: new Date().toISOString(),
    });
  }

  getRecent(count = 20): AgentMemoryEntry[] {
    return this.memories.slice(-count);
  }

  getByType(type: string, count = 10): AgentMemoryEntry[] {
    return this.memories.filter(m => m.type === type).slice(-count);
  }

  // Format memories as context string for LLM prompts
  formatForPrompt(count = 15): string {
    const recent = this.getRecent(count);
    if (recent.length === 0) return 'No prior memories.';

    return recent.map(m =>
      `[${m.timestamp.slice(0, 16)} | ${m.type} | importance: ${m.importance}] ${m.content}`
    ).join('\n');
  }

  get size(): number {
    return this.memories.length;
  }
}

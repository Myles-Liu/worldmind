import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LLMClient, getDefaultLLMClient } from '../llm/client.js';

// ─── Belief Types ───────────────────────────────────────────────

export interface Belief {
  id: string;
  subject: string;        // Entity or topic
  belief: string;         // Natural language statement
  confidence: number;     // 0-1
  supportingEvidence: string[];
  lastChallenged: string | null;
  agentSource: string;    // Which agent established this
  createdAt: string;
  updatedAt: string;
}

export interface BeliefState {
  beliefs: Belief[];
  worldSummary: string;
  confidenceOverall: number;
  lastUpdated: string;
  version: number;
}

// ─── World Model (LLM-based belief synthesis) ───────────────────

export interface WorldBeliefState {
  updatedAt: string;
  cycle: number;
  summary: string;           // Natural language summary of current world state
  topTrends: string[];       // Current top trends
  keyPlayers: string[];      // Most important entities
  predictions: string[];     // Active predictions
  confidence: number;        // Overall confidence in the model
}

export class WorldModel {
  private state: WorldBeliefState | null = null;
  private filePath: string;
  private llm: LLMClient;

  constructor(dataDir = 'data/world-model') {
    this.filePath = path.join(dataDir, 'belief-state.json');
    this.llm = getDefaultLLMClient();
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      this.state = JSON.parse(content);
    } catch {
      this.state = null;
    }
  }

  async save(): Promise<void> {
    if (!this.state) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2));
  }

  // Update belief state based on all agent outputs from this cycle
  async update(cycle: number, agentOutputsSummary: string): Promise<void> {
    const previousState = this.state
      ? `Previous world state (cycle ${this.state.cycle}):\n${this.state.summary}\nTop trends: ${this.state.topTrends.join(', ')}\n`
      : 'No previous state — this is the first observation cycle.';

    const systemPrompt = `You are a world model synthesizer. Your job is to maintain an accurate, concise model of the current state of the GitHub open source ecosystem based on agent observations.

Update the world model based on new observations. Preserve important information from the previous state while incorporating new data.

Respond in JSON:
{
  "summary": "2-3 paragraph summary of the current state of the ecosystem",
  "topTrends": ["trend1", "trend2", ...],
  "keyPlayers": ["entity1", "entity2", ...],
  "predictions": ["active prediction 1", ...],
  "confidence": 0.0-1.0
}`;

    const userPrompt = `${previousState}\n\nNew observations from cycle ${cycle}:\n${agentOutputsSummary}`;

    try {
      const result = await this.llm.json<{
        summary: string;
        topTrends: string[];
        keyPlayers: string[];
        predictions: string[];
        confidence: number;
      }>(systemPrompt, userPrompt);

      this.state = {
        updatedAt: new Date().toISOString(),
        cycle,
        ...result,
      };
    } catch (err) {
      console.error(`  [WorldModel] Failed to update belief state: ${err}`);
    }
  }

  getState(): WorldBeliefState | null {
    return this.state;
  }

  formatForPrompt(): string {
    if (!this.state) return 'No world model available yet.';
    return `World Model (updated cycle ${this.state.cycle}):\n${this.state.summary}\nTop trends: ${this.state.topTrends.join(', ')}\nKey players: ${this.state.keyPlayers.join(', ')}`;
  }

  /**
   * Format the world model state for agent context consumption.
   *
   * Produces a structured, information-dense summary suitable for
   * injection into agent prompts via the ContextEngine (Layer 2).
   * More detailed than formatForPrompt() — includes predictions
   * and confidence levels.
   *
   * @returns Formatted string, or empty string if no state exists
   */
  formatForAgentConsumption(): string {
    if (!this.state) return '';

    const sections: string[] = [];

    sections.push(`World Model — Cycle #${this.state.cycle} (${this.state.updatedAt.slice(0, 16)})`);
    sections.push(`Overall confidence: ${Math.round(this.state.confidence * 100)}%`);
    sections.push('');
    sections.push(this.state.summary);

    if (this.state.topTrends.length > 0) {
      sections.push('');
      sections.push(`Current top trends: ${this.state.topTrends.join(', ')}`);
    }

    if (this.state.keyPlayers.length > 0) {
      sections.push(`Key ecosystem players: ${this.state.keyPlayers.join(', ')}`);
    }

    if (this.state.predictions.length > 0) {
      sections.push('');
      sections.push('Active world model predictions:');
      for (const pred of this.state.predictions) {
        sections.push(`  • ${pred}`);
      }
    }

    return sections.join('\n');
  }
}

// ─── Legacy Belief State Manager (retained for compatibility) ───

export class BeliefStateManager {
  private state: BeliefState;
  private dataDir: string;

  constructor(dataDir: string = 'data') {
    this.dataDir = dataDir;
    this.state = {
      beliefs: [],
      worldSummary: 'No observations yet.',
      confidenceOverall: 0,
      lastUpdated: new Date().toISOString(),
      version: 0,
    };
  }

  /**
   * Load belief state from disk.
   */
  async load(): Promise<void> {
    const filePath = path.join(this.dataDir, 'belief-state.json');
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      this.state = JSON.parse(raw) as BeliefState;
    } catch {
      // File doesn't exist yet — use default state
    }
  }

  /**
   * Persist belief state to disk.
   */
  async save(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const filePath = path.join(this.dataDir, 'belief-state.json');
    await fs.writeFile(filePath, JSON.stringify(this.state, null, 2));
  }

  /**
   * Add or update a belief.
   */
  upsert(belief: Omit<Belief, 'id' | 'createdAt' | 'updatedAt'>): Belief {
    const now = new Date().toISOString();
    const existing = this.state.beliefs.find(
      (b) => b.subject === belief.subject && b.agentSource === belief.agentSource,
    );

    if (existing) {
      existing.belief = belief.belief;
      existing.confidence = belief.confidence;
      existing.supportingEvidence = belief.supportingEvidence;
      existing.lastChallenged = belief.lastChallenged;
      existing.updatedAt = now;
      this.state.version++;
      this.state.lastUpdated = now;
      return existing;
    }

    const newBelief: Belief = {
      id: `belief-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...belief,
      createdAt: now,
      updatedAt: now,
    };
    this.state.beliefs.push(newBelief);
    this.state.version++;
    this.state.lastUpdated = now;
    return newBelief;
  }

  /**
   * Get all beliefs about a subject.
   */
  getBeliefsAbout(subject: string): Belief[] {
    return this.state.beliefs.filter((b) => b.subject === subject);
  }

  /**
   * Apply confidence decay — beliefs without recent evidence lose confidence.
   */
  applyDecay(decayRate: number = 0.05): void {
    for (const belief of this.state.beliefs) {
      const age = Date.now() - new Date(belief.updatedAt).getTime();
      const daysSinceUpdate = age / (1000 * 60 * 60 * 24);
      if (daysSinceUpdate > 7) {
        belief.confidence = Math.max(0, belief.confidence - decayRate);
      }
    }
    // Remove beliefs with zero confidence
    this.state.beliefs = this.state.beliefs.filter((b) => b.confidence > 0);
  }

  /**
   * Update the world summary.
   */
  setWorldSummary(summary: string): void {
    this.state.worldSummary = summary;
    this.state.lastUpdated = new Date().toISOString();
  }

  /**
   * Get the current belief state summary (for agent context).
   */
  getSummary(): string {
    return this.state.worldSummary;
  }

  /**
   * Get the full state.
   */
  getState(): Readonly<BeliefState> {
    return this.state;
  }
}

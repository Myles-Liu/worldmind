/**
 * @module SharedContextBus
 *
 * Inter-agent communication bus for WorldMind.
 *
 * During each analysis cycle, agents run in a defined order:
 *   Trend → Network → Tech → Predict → Challenge
 *
 * Each agent publishes its outputs to the bus after completion.
 * Downstream agents read structured briefings from upstream agents
 * instead of parsing raw event streams.
 *
 * Design decisions:
 *
 * 1. **Structured briefings over raw dumps** — Agents don't see each other's
 *    raw JSON output. Instead, the bus produces natural-language summaries
 *    tailored for each consuming agent. This reduces noise and token waste.
 *
 * 2. **Immutable per-cycle** — Once a cycle starts, the bus creates a fresh
 *    context. Previous cycle data is not carried over (that's memory's job).
 *
 * 3. **World model integration** — The bus holds a reference to the current
 *    WorldModel belief state and formats it for agent consumption.
 *
 * 4. **Zero external dependencies** — Pure TypeScript, no event emitters
 *    or message queues. Agents are orchestrated sequentially, so a simple
 *    in-memory store suffices.
 */

import type { AgentOutput } from '../types/agent.js';
import type { WorldBeliefState } from '../world-model/belief-state.js';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Defines which agents each agent cares about for briefings.
 * Agents only receive briefings from their declared upstream dependencies.
 */
export interface AgentDependencies {
  [agentName: string]: string[];
}

/**
 * Default dependency graph for WorldMind agents.
 *
 * - Trend: no dependencies (runs first, reads raw events)
 * - Network: reads Trend's outputs for context on which repos matter
 * - Tech: reads Trend's outputs for technology signals
 * - Predict: reads all upstream agents (Trend, Network, Tech)
 * - Challenge: reads Predict's outputs to challenge them
 */
export const DEFAULT_AGENT_DEPENDENCIES: AgentDependencies = {
  trend: [],
  network: ['trend'],
  tech: ['trend'],
  predict: ['trend', 'network', 'tech'],
  challenge: ['predict'],
};

// ─── Briefing Formatters ────────────────────────────────────────

/**
 * Format trend signal outputs into a concise briefing.
 */
function formatTrendBriefing(outputs: AgentOutput[]): string {
  if (outputs.length === 0) return 'Trend Agent: No significant signals detected this cycle.';

  const signals = outputs
    .filter(o => o.outputType === 'trend_signal')
    .sort((a, b) => b.confidence - a.confidence);

  if (signals.length === 0) return 'Trend Agent: No significant signals detected this cycle.';

  const lines = signals.map(s => {
    const repo = s.data['repo'] as string ?? 'Unknown';
    const growth = s.data['predictedGrowth'] as string ?? 'unknown';
    const stars = s.data['stars'] as number ?? 0;
    const starsPerDay = s.data['starsPerDay'] as number ?? 0;
    const factors = (s.data['keyFactors'] as string[]) ?? [];
    const conf = Math.round(s.confidence * 100);
    return `• ${repo} — ${growth} growth, ${stars} stars (${starsPerDay}/day), conf: ${conf}%. ${factors.length > 0 ? `Key factors: ${factors.join(', ')}` : ''}`;
  });

  return `Trend Agent identified ${signals.length} signal(s):\n${lines.join('\n')}`;
}

/**
 * Format network analysis outputs into a concise briefing.
 */
function formatNetworkBriefing(outputs: AgentOutput[]): string {
  if (outputs.length === 0) return 'Network Agent: No network analysis available this cycle.';

  const updates = outputs.filter(o => o.outputType === 'network_update');
  if (updates.length === 0) return 'Network Agent: No network analysis available this cycle.';

  const parts: string[] = [];

  for (const update of updates) {
    const clusters = (update.data['clusters'] as Array<{ theme: string; repos: string[]; relationship: string }>) ?? [];
    const keyPlayers = (update.data['keyPlayers'] as Array<{ repo: string; role: string; reasoning: string }>) ?? [];
    const insights = (update.data['insights'] as string[]) ?? [];

    if (clusters.length > 0) {
      const clusterStr = clusters
        .slice(0, 5)
        .map(c => `  - ${c.theme} (${c.relationship}): ${c.repos.join(', ')}`)
        .join('\n');
      parts.push(`Clusters:\n${clusterStr}`);
    }

    if (keyPlayers.length > 0) {
      const playerStr = keyPlayers
        .slice(0, 5)
        .map(p => `  - ${p.repo} [${p.role}]`)
        .join('\n');
      parts.push(`Key Players:\n${playerStr}`);
    }

    if (insights.length > 0) {
      // Truncate each insight to 120 chars — downstream agents need conclusions, not essays
      parts.push(`Insights: ${insights.slice(0, 2).map(s => s.slice(0, 120)).join('; ')}`);
    }
  }

  return `Network Agent analysis:\n${parts.join('\n')}`;
}

/**
 * Format tech trend outputs into a concise briefing.
 */
function formatTechBriefing(outputs: AgentOutput[]): string {
  if (outputs.length === 0) return 'Tech Agent: No technology trends detected this cycle.';

  const trends = outputs.filter(o => o.outputType === 'tech_trend');
  if (trends.length === 0) return 'Tech Agent: No technology trends detected this cycle.';

  const parts: string[] = [];

  for (const trend of trends) {
    const rising = (trend.data['risingTechnologies'] as Array<{ name: string; signal: string; confidence: number }>) ?? [];
    const declining = (trend.data['decliningTechnologies'] as Array<{ name: string; signal: string; confidence: number }>) ?? [];
    const patterns = (trend.data['emergingPatterns'] as string[]) ?? [];

    if (rising.length > 0) {
      parts.push(`Rising: ${rising.map(t => `${t.name} (${t.signal}, ${Math.round(t.confidence * 100)}%)`).join(', ')}`);
    }
    if (declining.length > 0) {
      parts.push(`Declining: ${declining.map(t => `${t.name} (${t.signal}, ${Math.round(t.confidence * 100)}%)`).join(', ')}`);
    }
    if (patterns.length > 0) {
      parts.push(`Patterns: ${patterns.join('; ')}`);
    }
  }

  return `Tech Agent analysis:\n${parts.join('\n')}`;
}

/**
 * Format prediction outputs into a concise briefing.
 */
function formatPredictBriefing(outputs: AgentOutput[]): string {
  if (outputs.length === 0) return 'Predict Agent: No predictions made this cycle.';

  const predictions = outputs.filter(o => o.outputType === 'prediction_created');
  if (predictions.length === 0) return 'Predict Agent: No predictions made this cycle.';

  const lines = predictions.map(p => {
    const statement = p.data['statement'] as string ?? 'Unknown';
    const conf = Math.round(p.confidence * 100);
    return `• ${statement} (confidence: ${conf}%)`;
  });

  return `Predict Agent made ${predictions.length} prediction(s):\n${lines.join('\n')}`;
}

/**
 * Map of agent names to their briefing formatter.
 */
const BRIEFING_FORMATTERS: Record<string, (outputs: AgentOutput[]) => string> = {
  trend: formatTrendBriefing,
  network: formatNetworkBriefing,
  tech: formatTechBriefing,
  predict: formatPredictBriefing,
};

// ─── SharedContextBus ───────────────────────────────────────────

/**
 * SharedContextBus — Communication layer between agents within a cycle.
 *
 * Usage:
 * ```ts
 * const bus = new SharedContextBus();
 * bus.setWorldState(worldModel.getState());
 *
 * // After Trend Agent runs:
 * bus.publish('trend', trendOutputs);
 *
 * // Before Network Agent runs:
 * const briefing = bus.getAgentBriefing('network');
 * // → Contains formatted Trend Agent outputs
 * ```
 */
export class SharedContextBus {
  private outputs: Map<string, AgentOutput[]> = new Map();
  private worldState: WorldBeliefState | null = null;
  private dependencies: AgentDependencies;
  private cycleNumber: number = 0;

  constructor(dependencies?: AgentDependencies) {
    this.dependencies = dependencies ?? { ...DEFAULT_AGENT_DEPENDENCIES };
  }

  /**
   * Start a new cycle — clears all published outputs.
   */
  startCycle(cycleNumber: number): void {
    this.outputs.clear();
    this.cycleNumber = cycleNumber;
  }

  /**
   * Set the current world model belief state.
   * Called once at cycle start; agents read this for context.
   */
  setWorldState(state: WorldBeliefState | null): void {
    this.worldState = state;
  }

  /**
   * Publish agent outputs to the bus.
   * Called after each agent finishes its analysis.
   */
  publish(agentName: string, outputs: AgentOutput[]): void {
    const existing = this.outputs.get(agentName) ?? [];
    this.outputs.set(agentName, [...existing, ...outputs]);
  }

  /**
   * Get raw outputs from a specific agent.
   */
  getOutputs(agentName: string): AgentOutput[] {
    return this.outputs.get(agentName) ?? [];
  }

  /**
   * Get all published outputs across all agents.
   */
  getAllOutputs(): AgentOutput[] {
    const all: AgentOutput[] = [];
    for (const outputs of this.outputs.values()) {
      all.push(...outputs);
    }
    return all;
  }

  /**
   * Get a formatted briefing for a specific agent.
   *
   * The briefing only includes outputs from the agent's declared
   * upstream dependencies. This prevents information overload and
   * ensures agents only see what's relevant to their role.
   *
   * @param forAgent - The agent that will receive this briefing
   * @returns A natural-language briefing string, or empty string if no upstream data
   */
  getAgentBriefing(forAgent: string): string {
    const deps = this.dependencies[forAgent] ?? [];
    if (deps.length === 0) return '';

    const briefings: string[] = [];

    for (const dep of deps) {
      const outputs = this.outputs.get(dep) ?? [];
      const formatter = BRIEFING_FORMATTERS[dep];
      if (formatter) {
        briefings.push(formatter(outputs));
      } else {
        // Fallback: generic formatting for unknown agent types
        if (outputs.length > 0) {
          const summary = outputs
            .slice(0, 5)
            .map(o => `• [${o.outputType}] ${o.reasoning} (conf: ${Math.round(o.confidence * 100)}%)`)
            .join('\n');
          briefings.push(`${dep} Agent:\n${summary}`);
        }
      }
    }

    if (briefings.length === 0) return '';

    return `── Upstream Agent Briefings (Cycle #${this.cycleNumber}) ──\n\n${briefings.join('\n\n')}`;
  }

  /**
   * Get a natural-language summary of ALL published insights this cycle.
   * Used for WorldModel updates and reporting.
   */
  getSummary(): string {
    const allOutputs = this.getAllOutputs();
    if (allOutputs.length === 0) return 'No agent outputs this cycle.';

    const parts: string[] = [];

    // Group by agent
    const byAgent = new Map<string, AgentOutput[]>();
    for (const output of allOutputs) {
      const existing = byAgent.get(output.agentName) ?? [];
      existing.push(output);
      byAgent.set(output.agentName, existing);
    }

    for (const [agentName, outputs] of byAgent) {
      const formatter = BRIEFING_FORMATTERS[agentName];
      if (formatter) {
        parts.push(formatter(outputs));
      } else {
        parts.push(`${agentName}: ${outputs.length} output(s) — ${outputs.map(o => o.reasoning).join('; ')}`);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Get the world model context formatted for agent prompts.
   * Returns an empty string if no world state is available.
   */
  getWorldContext(): string {
    if (!this.worldState) return '';

    const parts: string[] = [
      `── Current World Model (Cycle #${this.worldState.cycle}) ──`,
      '',
      this.worldState.summary,
    ];

    if (this.worldState.topTrends.length > 0) {
      parts.push(`\nTop trends: ${this.worldState.topTrends.join(', ')}`);
    }

    if (this.worldState.keyPlayers.length > 0) {
      parts.push(`Key players: ${this.worldState.keyPlayers.join(', ')}`);
    }

    if (this.worldState.predictions.length > 0) {
      parts.push(`Active predictions: ${this.worldState.predictions.length}`);
    }

    parts.push(`\nModel confidence: ${Math.round(this.worldState.confidence * 100)}%`);

    return parts.join('\n');
  }

  /**
   * Get a structured summary suitable for WorldModel.update().
   * More structured than getSummary() — includes confidence scores
   * and categorization.
   */
  getStructuredSummary(): string {
    const allOutputs = this.getAllOutputs();
    if (allOutputs.length === 0) return 'No observations this cycle.';

    return allOutputs.map(o => {
      return `[${o.agentName}/${o.outputType}] (conf: ${Math.round(o.confidence * 100)}%) ${o.reasoning}`;
    }).join('\n');
  }

  /**
   * Check if a specific agent has published any outputs.
   */
  hasOutputs(agentName: string): boolean {
    const outputs = this.outputs.get(agentName);
    return outputs !== undefined && outputs.length > 0;
  }

  /**
   * Get the current cycle number.
   */
  get cycle(): number {
    return this.cycleNumber;
  }
}

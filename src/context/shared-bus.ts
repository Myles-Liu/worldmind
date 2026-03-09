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

// ─── Briefing Formatters ────────────────────────────────────────
// Each formatter uses the `summary` field from AgentOutput.
// Summaries are set by the producing agent — not re-parsed here.
// This keeps the bus thin and avoids coupling to data schemas.

function formatTrendBriefing(outputs: AgentOutput[]): string {
  const signals = outputs.filter(o => o.outputType === 'trend_signal');
  if (signals.length === 0) return 'Trend: no signals.';
  const lines = signals
    .sort((a, b) => b.confidence - a.confidence)
    .map(s => `• ${s.summary}`);
  return `Trend (${signals.length}):\n${lines.join('\n')}`;
}

function formatNetworkBriefing(outputs: AgentOutput[]): string {
  if (outputs.length === 0) return 'Network: no analysis.';
  return `Network:\n${outputs.map(o => `• ${o.summary}`).join('\n')}`;
}

function formatTechBriefing(outputs: AgentOutput[]): string {
  if (outputs.length === 0) return 'Tech: no trends.';
  return `Tech:\n${outputs.map(o => `• ${o.summary}`).join('\n')}`;
}

function formatPredictBriefing(outputs: AgentOutput[]): string {
  const preds = outputs.filter(o => o.outputType === 'prediction_created');
  if (preds.length === 0) return 'Predict: no predictions.';
  return `Predict (${preds.length}):\n${preds.map(p => `• ${p.summary}`).join('\n')}`;
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
   * WARNING: Use getOutputSummaries() for downstream agents to reduce context bloat.
   */
  getOutputs(agentName: string): AgentOutput[] {
    return this.outputs.get(agentName) ?? [];
  }

  /**
   * Get only summaries from an agent's outputs.
   * Used by downstream agents to reduce context size.
   * Each summary is max 100 chars.
   */
  getOutputSummaries(agentName: string): string[] {
    const outputs = this.outputs.get(agentName) ?? [];
    return outputs.map(o => {
      // Use explicit summary if available, otherwise generate from data
      if (o.summary) return o.summary.slice(0, 100);
      const target = o.data['repo'] ?? o.data['target'] ?? o.data['technology'] ?? 'unknown';
      return `[${o.outputType}] ${target}: ${o.reasoning.slice(0, 60)}...`;
    });
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

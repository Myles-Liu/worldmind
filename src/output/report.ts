import { promises as fs } from 'node:fs';
import type { AgentOutput } from '../types/agent.js';
import type { Prediction } from '../types/prediction.js';
import type { BeliefState, WorldBeliefState } from '../world-model/belief-state.js';

// ─── Report Types ───────────────────────────────────────────────

export interface WorldReport {
  generatedAt: string;
  period: { from: string; to: string };
  worldSummary: string;
  trendSignals: AgentOutput[];
  predictions: Prediction[];
  beliefState: BeliefState;
  stats: {
    entitiesTracked: number;
    eventsProcessed: number;
    activePredictions: number;
    predictionAccuracy: number | null;
  };
}

// ─── Report Generator ───────────────────────────────────────────

export class ReportGenerator {
  /**
   * Generate a world report from cycle data.
   */
  generate(params: {
    agentOutputs: Map<string, AgentOutput[]>;
    predictions: Prediction[];
    beliefState: BeliefState;
    period: { from: string; to: string };
    entitiesTracked: number;
    eventsProcessed: number;
  }): WorldReport {
    // TODO: Implement report generation
    // - Aggregate agent outputs
    // - Calculate prediction accuracy
    // - Generate narrative summary

    return {
      generatedAt: new Date().toISOString(),
      period: params.period,
      worldSummary: params.beliefState.worldSummary,
      trendSignals: params.agentOutputs.get('trend') ?? [],
      predictions: params.predictions,
      beliefState: params.beliefState,
      stats: {
        entitiesTracked: params.entitiesTracked,
        eventsProcessed: params.eventsProcessed,
        activePredictions: params.predictions.filter((p) => p.status === 'active').length,
        predictionAccuracy: null, // TODO: Calculate from verification records
      },
    };
  }

  /**
   * Render a report as Markdown.
   */
  toMarkdown(report: WorldReport): string {
    // TODO: Implement markdown rendering
    // - Header with date range
    // - World summary
    // - Trend signals section
    // - Predictions section
    // - Stats footer
    return `# WorldMind Report — ${report.generatedAt.slice(0, 10)}\n\n${report.worldSummary}`;
  }

  /**
   * Save report to disk.
   */
  async save(report: WorldReport, dir: string = 'data/reports'): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    const filename = `report-${report.generatedAt.slice(0, 10)}.json`;
    const filePath = `${dir}/${filename}`;
    await fs.writeFile(filePath, JSON.stringify(report, null, 2));
    return filePath;
  }
}

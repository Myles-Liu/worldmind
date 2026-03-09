/**
 * Social Domain Adapter
 *
 * Uses OASIS (camel-ai) as the simulation engine.
 * WorldMind agents analyze social simulation output to predict
 * information spread, group dynamics, and emergent behaviors.
 */

import type { DomainAdapter, DomainConfig, PredictionRequest, PredictionOutcome } from '../types.js';
import type { WorldEvent } from '../../types/event.js';
import type { Agent, AgentOutput } from '../../types/agent.js';
import { BaseAgent } from '../../agents/base-agent.js';
import { TrendAgent } from '../../agents/trend.js';
import { PredictAgent } from '../../agents/predict.js';
import { ChallengeAgent } from '../../agents/challenge.js';
import { OasisBridge, type OasisConfig } from './oasis-bridge.js';

// ─── Domain Config ──────────────────────────────────────────────

export const SocialDomainConfig: DomainConfig = {
  name: 'social',
  description: 'Social media simulation — information spread, group dynamics, emergent behaviors',
  entityTypes: ['agent', 'post', 'topic', 'community'],
  metrics: ['engagement', 'reach', 'sentiment', 'polarization', 'virality'],
  temporalRules: [
    'Viral posts peak within 2-4 hours, then decay exponentially',
    'Information cascades require a critical mass of early adopters (~10% of network)',
    'Echo chambers form within 3-5 simulation days as agents self-sort by interest',
    'Misinformation spreads 6x faster than corrections in polarized networks',
    'Peak activity hours (9-12, 14-16, 20-22) drive 60% of total engagement',
    'Cross-community bridges (weak ties) are the primary vector for novel information',
    'Group polarization increases monotonically with homophily in the network',
  ],
  agentContext: {
    trend: [
      'Domain: Social media simulation (OASIS).',
      'Key metrics: post count, engagement rate, repost ratio, sentiment distribution.',
      'Distinguish organic trends from algorithmic amplification.',
      'Information cascades are the primary signal — track which posts trigger chain reactions.',
    ].join(' '),
    predict: [
      'Domain: Social dynamics predictions.',
      'Base rate: most posts get <5 engagements. Viral spread is the exception.',
      'Predict: information reach, community polarization shifts, sentiment trajectories.',
      'Metrics: engagement, reach, sentiment, polarization, virality.',
    ].join(' '),
    challenge: [
      'Domain: Social simulation predictions.',
      'Base rate: most information stays local. True virality requires network structure support.',
      'LLM agents are more conformist than humans — simulated polarization may overestimate reality.',
      'Check: Is the prediction based on content quality or just network position?',
    ].join(' '),
  },
  initialKnowledge: [
    {
      topic: 'social_dynamics',
      content: 'LLM-based social agents exhibit stronger herding behavior than humans. When a post receives early downvotes, agents pile on; humans sometimes counter with sympathy engagement. Account for this simulation bias when interpreting results.',
      source: 'system',
      relevance: 0.9,
    },
    {
      topic: 'information_spread',
      content: 'Multi-signal posts (shared across communities) have highest breakout probability. Single-community posts plateau fast regardless of quality. Network topology matters more than content for virality.',
      source: 'system',
      relevance: 0.85,
    },
  ],
};

// ─── Adapter ────────────────────────────────────────────────────

export class SocialDomainAdapter implements DomainAdapter {
  readonly config = SocialDomainConfig;

  private agents: Agent[];
  private bridge: OasisBridge | null = null;
  private oasisConfig: OasisConfig;

  constructor(oasisConfig: OasisConfig) {
    this.oasisConfig = oasisConfig;

    this.agents = [
      new TrendAgent(),
      new PredictAgent(),
      new ChallengeAgent(),
    ];

    // Inject social-specific context
    const ctx = SocialDomainConfig.agentContext ?? {};
    for (const agent of this.agents) {
      if (agent instanceof BaseAgent && ctx[agent.name]) {
        agent.setDomainContext(ctx[agent.name]!);
      }
    }
  }

  /**
   * Collect events by running an OASIS simulation.
   */
  async collect(): Promise<WorldEvent[]> {
    this.bridge = new OasisBridge(this.oasisConfig);

    console.log(`  📡 Starting OASIS ${this.oasisConfig.platform} simulation...`);
    console.log(`     Rounds: ${this.oasisConfig.rounds ?? 10}`);
    console.log(`     Profile: ${this.oasisConfig.profilePath}`);

    await this.bridge.start();
    const state = await this.bridge.waitForCompletion();

    console.log(`     ✅ Simulation complete: ${state.totalActions} actions in ${state.round} rounds`);

    return this.bridge.toWorldEvents();
  }

  getAgents(): Agent[] {
    return this.agents;
  }

  verify(prediction: PredictionRequest, actual: Record<string, unknown>): PredictionOutcome {
    const actualValue = (actual[prediction.metric] as number) ?? 0;
    const error = actualValue > 0 ? (0 - actualValue) / actualValue : 0;
    return {
      correct: Math.abs(error) <= 0.3,
      error,
      actualValue,
    };
  }

  score(outputs: AgentOutput[]): number {
    if (outputs.length === 0) return 0;
    return outputs.reduce((sum, o) => sum + o.confidence, 0) / outputs.length;
  }

  /**
   * Get the OASIS bridge for direct access to simulation state.
   */
  getBridge(): OasisBridge | null {
    return this.bridge;
  }
}

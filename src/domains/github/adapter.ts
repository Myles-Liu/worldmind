/**
 * GitHub Domain Adapter
 *
 * Bridges the existing agents/collectors into the generic Domain interface.
 * No code was rewritten — this wraps what already exists.
 */

import type { DomainAdapter, DomainConfig, PredictionRequest, PredictionOutcome } from '../types.js';
import type { WorldEvent } from '../../types/event.js';
import type { Agent, AgentOutput } from '../../types/agent.js';
import { BaseAgent } from '../../agents/base-agent.js';
import { TrendAgent } from '../../agents/trend.js';
import { NetworkAgent } from '../../agents/network.js';
import { TechAgent } from '../../agents/tech.js';
import { PredictAgent } from '../../agents/predict.js';
import { ChallengeAgent } from '../../agents/challenge.js';

export const GitHubDomainConfig: DomainConfig = {
  name: 'github',
  description: 'Open source GitHub ecosystem — repos, developers, and technology trends',
  entityTypes: ['repo', 'user', 'org'],
  metrics: ['stars', 'forks', 'ranking', 'adoption'],
  temporalRules: [
    'Most repos plateau within 7-14 days after a viral spike',
    'Log-normal decay fits 5/7 repos; influencer-driven half-life is 1-3 days',
    'Tool repos sustain longer (half-life up to 85 days)',
    'Platform repos with ecosystem effects resist decay',
    'Weekend activity is typically 30-50% lower than weekdays',
    'Multi-signal repos (GitHub trending + HN) have highest breakout probability',
  ],
  agentContext: {
    trend: [
      'Domain: GitHub open source repositories.',
      'Key metrics: stars, forks, stars/day, contributor count.',
      'Star velocity alone ≠ trend. A repo with 100 genuine users > 10,000 star-and-leave visitors.',
      'Evaluate: problem significance, timing, community health, differentiation, growth quality (organic vs artificial).',
    ].join(' '),
    network: [
      'Domain: GitHub repositories and developers.',
      'Look for: shared contributors, mutual dependencies, common org backers, same-ecosystem projects.',
      'When multiple repos from the same community trend simultaneously, it signals a platform shift.',
    ].join(' '),
    tech: [
      'Domain: GitHub repositories representing technology adoption.',
      'Track languages, frameworks, paradigms via repository signals.',
      'Distinguish genuine adoption from conference-driven hype — look at what developers ship, not talk about.',
    ].join(' '),
    predict: [
      'Domain: GitHub star count predictions.',
      'Base rate: most repos plateau within 7-14 days. Explosive sustained growth is the exception.',
      'Most repos never reach 1,000 stars. Influencer-driven repos decay fast (half-life 1-3 days).',
      'Metrics: stars (primary), forks, ranking, adoption.',
    ].join(' '),
    challenge: [
      'Domain: GitHub star predictions.',
      'Base rate: most repos never reach 1,000 stars.',
      '"Famous author" is not evidence. Karpathy repos spike then plateau like everything else.',
      'Hype cycles are predictable: HN front page → spike → 80% decay in 7 days.',
    ].join(' '),
  },
  initialKnowledge: [
    {
      topic: 'github_trends',
      content: 'Be cautious about declaring repos as "artificially inflated" without strong evidence. Coordinated ecosystem launches (multiple repos from the same org trending simultaneously) are a legitimate and common strategy.',
      source: 'system',
      relevance: 0.8,
    },
  ],
};

export class GitHubDomainAdapter implements DomainAdapter {
  readonly config = GitHubDomainConfig;

  private githubToken?: string;
  private agents: Agent[];

  constructor(options?: { githubToken?: string }) {
    this.githubToken = options?.githubToken;
    
    // Agent name → domain context role mapping
    const roleMap: Record<string, string> = {
      trend: 'trend',
      network: 'network',
      tech: 'tech',
      predict: 'predict',
      challenge: 'challenge',
    };
    
    this.agents = [
      new TrendAgent(),
      new NetworkAgent(),
      new TechAgent(),
      new PredictAgent(),
      new ChallengeAgent(),
    ];
    
    // Inject domain-specific context into each agent
    const ctx = GitHubDomainConfig.agentContext ?? {};
    for (const agent of this.agents) {
      const role = roleMap[agent.name] ?? agent.name;
      if (ctx[role] && agent instanceof BaseAgent) {
        agent.setDomainContext(ctx[role]!);
      }
    }
  }

  async collect(): Promise<WorldEvent[]> {
    // Delegate to existing discovery pipeline
    // This will be wired up when we refactor the pipeline runner
    throw new Error('Use scripts/run-discovery-analysis.ts for now. Full pipeline integration coming soon.');
  }

  getAgents(): Agent[] {
    return this.agents;
  }

  verify(prediction: PredictionRequest, actual: Record<string, unknown>): PredictionOutcome {
    const actualValue = (actual[prediction.metric] as number) ?? 0;
    const predictedValue = 0; // will be passed in via richer interface
    const error = actualValue > 0 ? (predictedValue - actualValue) / actualValue : 0;
    return {
      correct: Math.abs(error) <= 0.3, // within 30% = correct
      error,
      actualValue,
    };
  }

  score(outputs: AgentOutput[]): number {
    if (outputs.length === 0) return 0;
    return outputs.reduce((sum, o) => sum + o.confidence, 0) / outputs.length;
  }
}

/**
 * Crypto Domain Adapter
 *
 * Demonstrates WorldMind's domain-agnostic architecture.
 * Uses free CoinGecko API — no API key required.
 */

import { execSync } from 'node:child_process';
import type { DomainAdapter, DomainConfig, PredictionRequest, PredictionOutcome } from '../types.js';
import type { WorldEvent } from '../../types/event.js';
import type { Agent, AgentOutput } from '../../types/agent.js';
import { BaseAgent } from '../../agents/base-agent.js';
import { TrendAgent } from '../../agents/trend.js';
import { PredictAgent } from '../../agents/predict.js';
import { ChallengeAgent } from '../../agents/challenge.js';
import { createEvent } from '../../types/event.js';

// ─── Domain Config ──────────────────────────────────────────────

export const CryptoDomainConfig: DomainConfig = {
  name: 'crypto',
  description: 'Cryptocurrency market — tokens, protocols, and market dynamics',
  entityTypes: ['token', 'protocol', 'exchange'],
  metrics: ['price', 'market_cap', 'volume', '24h_change'],
  temporalRules: [
    'Bitcoin halving events precede bull runs by 3-6 months',
    'Alt seasons follow BTC dominance drops below 50%',
    'Most tokens lose 80-95% from ATH during bear markets',
    'Meme coins can pump 100x in days but rarely sustain 30 days',
    'Layer 1 tokens correlate ~0.8 with BTC short-term',
    'DeFi TVL is a leading indicator of protocol health',
    'Weekend volume is typically 20-40% lower than weekdays',
  ],
  agentContext: {
    trend: [
      'Domain: Cryptocurrency markets.',
      'Key metrics: price, market cap, 24h change, volume.',
      'A token pumping 50% in a day is noise — evaluate fundamentals, catalysts, and market regime.',
      'BTC correlation matters: if everything pumps, it\'s macro, not token-specific.',
    ].join(' '),
    predict: [
      'Domain: Cryptocurrency price predictions.',
      'Base rate: 90% of tokens underperform BTC over 1 year.',
      'Volatility is extreme — 30-day predictions should use wide confidence intervals.',
      'Never predict exact prices. Predict ranges or directional moves.',
      'Metrics: price (primary), market_cap, volume.',
    ].join(' '),
    challenge: [
      'Domain: Crypto price predictions.',
      'Base rate: most tokens lose value. Survivorship bias is rampant.',
      '"This time is different" has been wrong every cycle.',
      'Check: Is the prediction just extrapolating recent momentum? That fails in crypto.',
      'Meme coin predictions above 7 days are nearly worthless.',
    ].join(' '),
  },
  initialKnowledge: [
    {
      topic: 'crypto_cycles',
      content: 'Bitcoin cycle: halving → accumulation (6-12 months) → bull run (12-18 months) → blow-off top → bear market (12-18 months). Alt coins follow with a lag of 1-3 months. Most tokens never recover their ATH from the previous cycle.',
      source: 'system',
      relevance: 0.9,
    },
    {
      topic: 'crypto_fundamentals',
      content: 'Token fundamental analysis: developer activity (GitHub commits), TVL growth, unique active wallets, fee revenue, token emission schedule. Price without fundamentals = speculation. Speculation can last months but always mean-reverts.',
      source: 'system',
      relevance: 0.8,
    },
  ],
};

// ─── Token metadata ─────────────────────────────────────────────

const TOP_TOKENS = [
  'bitcoin', 'ethereum', 'solana', 'cardano', 'avalanche-2',
  'polkadot', 'chainlink', 'uniswap', 'aave', 'arbitrum',
];

// ─── Adapter ────────────────────────────────────────────────────

export class CryptoDomainAdapter implements DomainAdapter {
  readonly config = CryptoDomainConfig;

  private agents: Agent[];
  private tokens: string[];

  constructor(options?: { tokens?: string[] }) {
    this.tokens = options?.tokens ?? TOP_TOKENS;

    // Reuse engine agents with crypto domain context
    this.agents = [
      new TrendAgent(),
      new PredictAgent(),
      new ChallengeAgent(),
    ];

    // Inject crypto-specific context
    const ctx = CryptoDomainConfig.agentContext ?? {};
    for (const agent of this.agents) {
      if (agent instanceof BaseAgent && ctx[agent.name]) {
        agent.setDomainContext(ctx[agent.name]!);
      }
    }
  }

  async collect(): Promise<WorldEvent[]> {
    const ids = this.tokens.join(',');
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&per_page=50&sparkline=false&price_change_percentage=1h,24h,7d,30d`;

    let data: any[];
    try {
      const raw = execSync(
        `curl -sf "${url}"`,
        { timeout: 15000, encoding: 'utf-8' }
      );
      data = JSON.parse(raw);
    } catch (err) {
      console.error('  ⚠️  CoinGecko API error:', (err as Error).message);
      return [];
    }

    return data.map((token: any) =>
      createEvent({
        type: 'token_market_update',
        source: 'collector:coingecko',
        entities: [`token:${token.id}`],
        data: {
          metadata: {
            fullName: `${token.name} (${token.symbol.toUpperCase()})`,
            id: token.id,
            symbol: token.symbol,
            name: token.name,
            image: token.image,
          },
          price: token.current_price,
          marketCap: token.market_cap,
          volume24h: token.total_volume,
          change1h: token.price_change_percentage_1h_in_currency,
          change24h: token.price_change_percentage_24h,
          change7d: token.price_change_percentage_7d_in_currency,
          change30d: token.price_change_percentage_30d_in_currency,
          ath: token.ath,
          athChangePercent: token.ath_change_percentage,
          rank: token.market_cap_rank,
        },
        importance: Math.min(1, (token.market_cap ?? 0) / 1e12), // normalize by $1T
      })
    );
  }

  getAgents(): Agent[] {
    return this.agents;
  }

  verify(prediction: PredictionRequest, actual: Record<string, unknown>): PredictionOutcome {
    const actualValue = (actual[prediction.metric] as number) ?? 0;
    const predictedValue = 0;
    const error = actualValue > 0 ? (predictedValue - actualValue) / actualValue : 0;
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
}

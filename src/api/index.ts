/**
 * WorldMind Public API
 *
 * This is the main entry point for using WorldMind as a library.
 *
 * ```ts
 * import { WorldModel, GitHubDomain } from 'worldmind';
 *
 * // Use built-in GitHub domain
 * const world = WorldModel.forGitHub({ token: process.env.GITHUB_TOKEN });
 * const results = await world.observe();      // discover what's happening
 * const prediction = await world.predict({    // predict the future
 *   target: 'facebook/react',
 *   metric: 'stars',
 *   timeframe: '30d',
 * });
 *
 * // Or create a custom domain
 * const custom = WorldModel.create({
 *   name: 'crypto',
 *   description: 'Cryptocurrency market trends',
 *   entityTypes: ['token', 'protocol', 'exchange'],
 *   metrics: ['price', 'volume', 'tvl'],
 *   knowledge: [
 *     { topic: 'market_cycles', content: 'Bull runs last ~18 months on average...' },
 *   ],
 * });
 * ```
 */

export { WorldModel } from '../domains/types.js';
export type {
  DomainConfig,
  DomainAdapter,
  PredictionRequest,
  PredictionResult,
  PredictionOutcome,
  WorldModelOptions,
} from '../domains/types.js';

// Built-in domains
export { GitHubDomainAdapter, GitHubDomainConfig } from '../domains/github/adapter.js';
export { CryptoDomainAdapter, CryptoDomainConfig } from '../domains/crypto/adapter.js';
export { SocialDomainAdapter, SocialDomainConfig } from '../domains/social/adapter.js';
export { OasisBridge, type OasisConfig } from '../domains/social/oasis-bridge.js';

// Engine components (for advanced users building custom domains)
export { BaseAgent } from '../agents/base-agent.js';
export { ContextEngine } from '../llm/context-engine.js';
export { SharedContextBus } from '../context/shared-bus.js';
export { KnowledgeBase } from '../memory/knowledge-base.js';
export { SemanticMemory } from '../memory/semantic-memory.js';
export { LLMClient, getDefaultLLMClient } from '../llm/client.js';
export type { AgentOutput, Agent, AgentConfig } from '../types/agent.js';
export type { WorldEvent } from '../types/event.js';
export { createEvent } from '../types/event.js';

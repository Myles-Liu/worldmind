/**
 * Domain Adapter 接口
 * 
 * WorldModel 引擎通过 Domain Adapter 接入不同的领域。
 * 每个 adapter 定义：该领域的数据源、实体类型、指标、可用的 agents。
 */

import type { WorldEvent } from '../types/event.js';
import type { Agent, AgentOutput, AgentConfig } from '../types/agent.js';
import type { KnowledgeEntry } from '../memory/knowledge-base.js';

// ─── Domain Definition ───────────────────────────────────────────

export interface DomainConfig {
  /** Domain 唯一标识 */
  name: string;
  
  /** Domain 的人类可读描述 */
  description: string;
  
  /** 该领域关注哪些类型的实体 */
  entityTypes: string[];  // e.g., ['repo', 'user', 'org'] for GitHub
  
  /** 该领域可以预测哪些指标 */
  metrics: string[];  // e.g., ['stars', 'forks', 'adoption']
  
  /** 时态规则/启发式（可选） */
  temporalRules?: string[];
  
  /** 初始知识库（可选） */
  initialKnowledge?: Omit<KnowledgeEntry, 'id' | 'addedAt'>[];
  
  /**
   * Domain-specific agent context — injected into Layer 1 of each agent's prompt.
   * 
   * Keys are role-based (not agent names), so different domains can use
   * the same agent pipeline with different instructions.
   * 
   * Example:
   * ```ts
   * agentContext: {
   *   trend:     'Identify repos with breakout potential. Stars ≠ quality.',
   *   predict:   'Predict star counts. Base rate: most repos plateau in 7-14d.',
   *   challenge: 'Most repos never reach 1000 stars. Attack weak evidence.',
   *   network:   'Map shared contributors, dependencies, org backing.',
   *   tech:      'Track language/framework adoption cycles.',
   * }
   * ```
   */
  agentContext?: Record<string, string>;
}

/**
 * Domain Adapter 实现
 */
export interface DomainAdapter {
  readonly config: DomainConfig;
  
  // ─── Data Collection ─────────────────────────────────────────
  
  /** 获取该领域的原始数据（用于观察） */
  collect(): Promise<WorldEvent[]>;
  
  // ─── Agents ──────────────────────────────────────────────────
  
  /** 该 domain 提供的 agents */
  getAgents(): Agent[];
  
  // ─── Evaluation ───────────────────────────────────────────────
  
  /** 验证预测是否正确 */
  verify(prediction: PredictionRequest, actual: Record<string, unknown>): PredictionOutcome;
  
  /** 计算该领域的评分 */
  score(outputs: AgentOutput[]): number;
}

// ─── Prediction API ─────────────────────────────────────────────

export interface PredictionRequest {
  target: string;           // 实体 ID
  metric: string;           // 指标名
  timeframe: string;        // '30d', '90d', '1y' 等
  context?: string;        // 额外的上下文信息
}

export interface PredictionResult {
  id: string;
  request: PredictionRequest;
  predictedValue: number;
  confidence: number;       // 0-1
  reasoning: string;
  evidence: string[];
  debateRounds: number;     // 0 = no challenge, 1+ = after challenge
  revisedFrom?: number;     // 如果经过挑战修订，记录原始预测
  createdAt: string;
}

export interface PredictionOutcome {
  correct: boolean;
  error: number;            // 预测误差百分比
  actualValue: number;
}

// ─── WorldModel Engine ───────────────────────────────────────────

export interface WorldModelOptions {
  /** Domain 配置 */
  domain: DomainConfig | DomainAdapter;
  
  /** LLM 配置 */
  llm?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
  
  /** 数据源配置 */
  collectors?: {
    github?: { token?: string };
    hn?: { enabled?: boolean };
    rss?: { feeds?: string[] };
  };
}

/**
 * WorldModel 引擎
 * 
 * 使用方式：
 * 
 * ```ts
 * import { WorldModel, GitHubDomain } from 'worldmind';
 * 
 * const world = new WorldModel({
 *   domain: GitHubDomain,
 *   llm: { apiKey: process.env.OPENAI_API_KEY }
 * });
 * 
 * const prediction = await world.predict({
 *   target: 'facebook/react',
 *   metric: 'stars',
 *   timeframe: '30d'
 * });
 * ```
 */
export class WorldModel {
  private domain: DomainAdapter;
  private config: DomainConfig;
  
  constructor(options: WorldModelOptions) {
    if ('collect' in options.domain) {
      this.domain = options.domain;
      this.config = options.domain.config;
    } else {
      // TODO: 根据 config 创建对应的 adapter
      throw new Error('Custom domain config not yet implemented. Use a built-in domain adapter.');
    }
  }
  
  /**
   * 执行一次完整的观察→推理→预测循环
   */
  async runCycle(): Promise<PredictionResult[]> {
    // 1. 收集数据
    const events = await this.domain.collect();
    
    // 2. 运行 agents
    const outputs = await this.runAgents(events);
    
    // 3. 生成预测
    const predictions = await this.generatePredictions(outputs);
    
    // 4. 挑战 & 修订
    const finalized = await this.challengeAndRevise(predictions, outputs);
    
    return finalized;
  }
  
  /**
   * 预测特定实体在特定时间后的指标值
   */
  async predict(request: PredictionRequest): Promise<PredictionResult> {
    const results = await this.runCycle();
    // 找到匹配 target + metric 的预测
    const match = results.find(r => 
      r.request.target === request.target && 
      r.request.metric === request.metric
    );
    if (!match) {
      throw new Error(`No prediction found for ${request.target}/${request.metric}`);
    }
    return match;
  }
  
  /**
   * 时间轴推理：问"如果快进 X 天会怎样"
   */
  async fastForward(request: PredictionRequest): Promise<{
    currentValue: number;
    predictedValue: number;
    confidence: number;
    reasoning: string;
  }> {
    // TODO: 实现时间轴推理
    const prediction = await this.predict(request);
    return {
      currentValue: prediction.request.context ? 0 : 0, // TODO: 从 domain 获取当前值
      predictedValue: prediction.predictedValue,
      confidence: prediction.confidence,
      reasoning: prediction.reasoning,
    };
  }
  
  // ─── Private ──────────────────────────────────────────────────
  
  private async runAgents(events: WorldEvent[]): Promise<AgentOutput[]> {
    const agents = this.domain.getAgents();
    const outputs: AgentOutput[] = [];
    
    for (const agent of agents) {
      if (!agent.config.enabled) continue;
      const result = await agent.analyze(events);
      outputs.push(...result);
    }
    
    return outputs;
  }
  
  private async generatePredictions(outputs: AgentOutput[]): Promise<PredictionResult[]> {
    // TODO: 从 Predict agent 获取预测
    return [];
  }
  
  private async challengeAndRevise(
    predictions: PredictionResult[],
    outputs: AgentOutput[]
  ): Promise<PredictionResult[]> {
    // TODO: 运行 Challenge agent 并修订
    return predictions;
  }
}

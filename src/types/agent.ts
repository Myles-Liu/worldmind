import type { WorldEvent, EventFilter } from './event.js';
import type { EntityProfile } from './entity.js';

// ─── Agent Output ───────────────────────────────────────────────

export interface AgentOutput {
  agentName: string;
  outputType: string;
  data: Record<string, unknown>;
  confidence: number; // 0-1
  reasoning: string;
  timestamp: string;
  relatedEntities: string[]; // Entity IDs
}

// ─── Trend Signal ───────────────────────────────────────────────

export type TrendSignalType =
  | 'star_anomaly'
  | 'fork_surge'
  | 'contributor_influx'
  | 'new_notable_repo'
  | 'category_shift'
  | 'tastemaker_signal';

export interface TrendSignal extends AgentOutput {
  outputType: 'trend_signal';
  data: {
    repo: string;
    signalType: TrendSignalType;
    metrics: {
      starsPerDay: number;
      starsTotal: number;
      forkToStarRatio: number;
      contributorCount: number;
      daysSinceCreation: number;
    };
    context: string; // LLM-generated context about why this is notable
  };
}

// ─── Graph Update ───────────────────────────────────────────────

export type GraphUpdateType =
  | 'new_relationship'
  | 'relationship_strengthened'
  | 'relationship_weakened'
  | 'community_formed'
  | 'community_merged'
  | 'community_split'
  | 'influencer_identified';

export interface GraphUpdate extends AgentOutput {
  outputType: 'graph_update';
  data: {
    updateType: GraphUpdateType;
    entities: string[];
    relationships: Array<{
      from: string;
      to: string;
      type: string;
      weight: number;
    }>;
    communityChanges?: {
      communityId: string;
      action: 'formed' | 'merged' | 'split' | 'dissolved';
      members: string[];
    };
  };
}

// ─── Tech Trend ─────────────────────────────────────────────────

export type TechLifecycleStage =
  | 'emerging'
  | 'growing'
  | 'mature'
  | 'declining'
  | 'deprecated';

export interface TechTrend extends AgentOutput {
  outputType: 'tech_trend';
  data: {
    technology: string;
    category: string; // e.g., 'frontend_framework', 'database', 'language'
    lifecycleStage: TechLifecycleStage;
    adoptionVelocity: number; // Positive = growing, negative = declining
    migrationSignals: Array<{
      from: string;
      to: string;
      strength: number; // 0-1
      evidence: string;
    }>;
    competingTechs: string[];
  };
}

// ─── Prediction Feedback ────────────────────────────────────────

export interface PredictionFeedback {
  predictionId: string;
  outcome: 'correct' | 'partially_correct' | 'incorrect' | 'unverifiable';
  actualValue?: string;
  notes: string;
  verifiedAt: string;
}

// ─── Agent Configuration ────────────────────────────────────────

export interface AgentConfig {
  name: string;
  enabled: boolean;
  llmModel?: string; // Override default model for this agent
  maxEventsPerCycle: number;
  confidenceThreshold: number; // Minimum confidence to publish output
}

// ─── Agent Interface ────────────────────────────────────────────

export interface Agent {
  readonly name: string;
  readonly description: string;
  readonly config: AgentConfig;

  /**
   * Process a batch of events and produce analysis outputs.
   * This is the core reasoning method.
   */
  analyze(events: WorldEvent[]): Promise<AgentOutput[]>;

  /**
   * Receive feedback on past predictions to improve future performance.
   */
  reflect(feedback: PredictionFeedback[]): Promise<void>;

  /**
   * Return the memory keys this agent needs from the entity store.
   */
  getMemoryKeys(): string[];

  /**
   * Generate a natural language summary of the agent's current state.
   */
  summarizeState(): Promise<string>;
}

// ─── Agent Context ──────────────────────────────────────────────

/**
 * Context provided to agents during analysis.
 * Agents use this to query memory, other agent outputs, and the world model.
 */
export interface AgentContext {
  /** Query events from the event log */
  queryEvents(filter: EventFilter): Promise<WorldEvent[]>;

  /** Get an entity profile */
  getEntity(entityId: string): Promise<EntityProfile | null>;

  /** Search entities by criteria */
  searchEntities(query: string, type?: string): Promise<EntityProfile[]>;

  /** Get outputs from other agents in this cycle */
  getAgentOutputs(agentName: string): AgentOutput[];

  /** Get the current belief state summary */
  getBeliefSummary(): Promise<string>;
}

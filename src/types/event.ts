import { z } from 'zod';

// ─── Event Types ────────────────────────────────────────────────
// Core events are domain-agnostic. Domain adapters can use any string.

/** Core event types used by the engine itself. */
export const CoreEventTypes = [
  // Agent events (analysis outputs)
  'trend_signal',
  'network_update',
  'tech_trend',
  'prediction_created',
  'prediction_challenged',
  'prediction_finalized',
  'prediction_verified',

  // System events
  'cycle_started',
  'cycle_completed',
  'agent_error',
  'belief_updated',
] as const;

/** GitHub domain event types. */
export const GitHubEventTypes = [
  'repo_discovered',
  'repo_trending',
  'repo_stars_updated',
  'repo_fork_created',
  'repo_issue_opened',
  'repo_pr_opened',
  'repo_pr_merged',
  'repo_release_published',
  'user_discovered',
  'user_followed',
  'user_contributed',
  'org_discovered',
  'new_repo_discovered',
  'hn_mention',
] as const;

/**
 * EventType is now an open string (not a closed enum).
 * Core + GitHub types are pre-defined for convenience.
 * Custom domains can use any string as an event type.
 */
export const EventType = z.string();
export type EventType = string;

// Type-safe constants for known event types
export const EVENT = {
  // Core
  TREND_SIGNAL: 'trend_signal' as EventType,
  NETWORK_UPDATE: 'network_update' as EventType,
  TECH_TREND: 'tech_trend' as EventType,
  PREDICTION_CREATED: 'prediction_created' as EventType,
  PREDICTION_CHALLENGED: 'prediction_challenged' as EventType,
  PREDICTION_FINALIZED: 'prediction_finalized' as EventType,
  PREDICTION_VERIFIED: 'prediction_verified' as EventType,
  CYCLE_STARTED: 'cycle_started' as EventType,
  CYCLE_COMPLETED: 'cycle_completed' as EventType,
  AGENT_ERROR: 'agent_error' as EventType,
  BELIEF_UPDATED: 'belief_updated' as EventType,
  // GitHub domain
  REPO_DISCOVERED: 'repo_discovered' as EventType,
  REPO_TRENDING: 'repo_trending' as EventType,
  NEW_REPO_DISCOVERED: 'new_repo_discovered' as EventType,
  HN_MENTION: 'hn_mention' as EventType,
} as const;

// ─── Event Source ───────────────────────────────────────────────
// Also open — any string. Convention: "category:name"

export const EventSource = z.string();
export type EventSource = string;

// ─── World Event ────────────────────────────────────────────────

export const WorldEvent = z.object({
  id: z.string(),
  timestamp: z.string(), // ISO 8601
  type: EventType,
  source: EventSource,
  entities: z.array(z.string()), // Entity IDs involved
  data: z.record(z.unknown()),
  importance: z.number().min(0).max(1), // For prioritizing agent attention
});
export type WorldEvent = z.infer<typeof WorldEvent>;

// ─── Event Filters ──────────────────────────────────────────────

export interface EventFilter {
  types?: EventType[];
  sources?: EventSource[];
  entities?: string[];
  fromTimestamp?: string;
  toTimestamp?: string;
  minImportance?: number;
  limit?: number;
}

// ─── Helpers ────────────────────────────────────────────────────

let _counter = 0;

export function createEvent(
  params: Omit<WorldEvent, 'id' | 'timestamp'> & { timestamp?: string },
): WorldEvent {
  return {
    id: crypto.randomUUID?.() ?? `evt-${Date.now()}-${_counter++}`,
    timestamp: new Date().toISOString(),
    ...params,
  };
}

export function isCollectorEvent(event: WorldEvent): boolean {
  return event.source.startsWith('collector:');
}

export function isAgentEvent(event: WorldEvent): boolean {
  return event.source.startsWith('agent:');
}

export function isSystemEvent(event: WorldEvent): boolean {
  return event.source.startsWith('system:');
}

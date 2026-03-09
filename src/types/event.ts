import { z } from 'zod';

// ─── Event Types ────────────────────────────────────────────────

export const EventType = z.enum([
  // Collector events (raw observations)
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

  // Discovery pipeline events
  'new_repo_discovered',  // NewRepoScanner: fresh repo with early traction
  'hn_mention',           // HNCollector: repo mentioned on Hacker News

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
]);
export type EventType = z.infer<typeof EventType>;

// ─── Event Source ───────────────────────────────────────────────

export const EventSource = z.enum([
  'collector:github',
  'collector:new-repos',
  'collector:hn',
  'collector:rss',
  'collector:backtest',
  'agent:trend',
  'agent:network',
  'agent:tech',
  'agent:predict',
  'agent:challenge',
  'system:orchestrator',
  'system:validator',
]);
export type EventSource = z.infer<typeof EventSource>;

// ─── World Event ────────────────────────────────────────────────

export const WorldEvent = z.object({
  id: z.string().uuid(),
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

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { WorldEvent, EventFilter } from '../types/event.js';

// ─── Event Log ──────────────────────────────────────────────────

export class EventLog {
  private recentEvents: WorldEvent[] = []; // Short-term memory buffer
  private maxRecentEvents: number;
  private dataDir: string;

  constructor(dataDir: string = 'data/events', maxRecentEvents: number = 1000) {
    this.dataDir = dataDir;
    this.maxRecentEvents = maxRecentEvents;
  }

  /**
   * Append events to the log.
   */
  async append(events: WorldEvent[]): Promise<void> {
    if (events.length === 0) return;

    // Add to in-memory buffer
    this.recentEvents.push(...events);
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents = this.recentEvents.slice(-this.maxRecentEvents);
    }

    // Persist to daily JSONL files
    const byDay = new Map<string, WorldEvent[]>();
    for (const event of events) {
      const day = event.timestamp.slice(0, 10); // YYYY-MM-DD
      const dayEvents = byDay.get(day) ?? [];
      dayEvents.push(event);
      byDay.set(day, dayEvents);
    }

    for (const [day, dayEvents] of byDay) {
      const filePath = path.join(this.dataDir, `${day}.jsonl`);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const lines = dayEvents.map((e) => JSON.stringify(e)).join('\n') + '\n';
      await fs.appendFile(filePath, lines);
    }
  }

  /**
   * Query events from the in-memory buffer.
   */
  query(filter: EventFilter): WorldEvent[] {
    let results = [...this.recentEvents];

    if (filter.types?.length) {
      results = results.filter((e) => filter.types!.includes(e.type));
    }
    if (filter.sources?.length) {
      results = results.filter((e) => filter.sources!.includes(e.source));
    }
    if (filter.entities?.length) {
      results = results.filter((e) =>
        e.entities.some((eid) => filter.entities!.includes(eid)),
      );
    }
    if (filter.fromTimestamp) {
      results = results.filter((e) => e.timestamp >= filter.fromTimestamp!);
    }
    if (filter.toTimestamp) {
      results = results.filter((e) => e.timestamp <= filter.toTimestamp!);
    }
    if (filter.minImportance !== undefined) {
      results = results.filter((e) => e.importance >= filter.minImportance!);
    }
    if (filter.limit) {
      results = results.slice(-filter.limit);
    }

    return results;
  }

  /**
   * Load events from disk for a specific date range.
   */
  async loadRange(fromDate: string, toDate: string): Promise<WorldEvent[]> {
    const events: WorldEvent[] = [];
    try {
      const files = await fs.readdir(this.dataDir).catch(() => []);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const date = file.replace('.jsonl', '');
        if (date >= fromDate && date <= toDate) {
          const content = await fs.readFile(path.join(this.dataDir, file), 'utf-8');
          const lines = content.split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              events.push(JSON.parse(line) as WorldEvent);
            } catch {
              // Skip invalid lines
            }
          }
        }
      }
    } catch {
      // Data directory doesn't exist yet
    }
    return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /**
   * Get the most recent N events.
   */
  getRecent(n: number = 100): WorldEvent[] {
    return this.recentEvents.slice(-n);
  }

  /**
   * Get total event count in memory.
   */
  get size(): number {
    return this.recentEvents.length;
  }
}

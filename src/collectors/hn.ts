/**
 * Hacker News Collector
 * 
 * Monitors HN for GitHub repo mentions in top/new/best stories.
 * HN API is free, no auth needed, no rate limit concerns.
 * 
 * API docs: https://github.com/HackerNews/API
 */

import { execSync } from 'node:child_process';
import { createEvent, type WorldEvent } from '../types/event.js';
import { makeEntityId } from '../types/entity.js';

// ─── Types ──────────────────────────────────────────────────────

interface HNItem {
  id: number;
  type: 'story' | 'comment' | 'job' | 'poll' | 'pollopt';
  by?: string;
  time?: number;
  title?: string;
  url?: string;
  text?: string;
  score?: number;
  descendants?: number; // comment count
  kids?: number[];
}

interface HNRepoMention {
  item: HNItem;
  repoFullName: string;  // e.g. "owner/repo"
  mentionType: 'direct_link' | 'show_hn' | 'discussion';
}

export interface HNCollectorConfig {
  /** How many top stories to scan (max 500) */
  topStoriesLimit: number;
  /** How many new stories to scan */
  newStoriesLimit: number;
  /** How many "best" stories to scan */
  bestStoriesLimit: number;
  /** Minimum score to consider a story relevant */
  minScore: number;
  /** Max age in hours for stories to consider */
  maxAgeHours: number;
}

const DEFAULT_CONFIG: HNCollectorConfig = {
  topStoriesLimit: 60,
  newStoriesLimit: 100,
  bestStoriesLimit: 30,
  minScore: 5,
  maxAgeHours: 72,
};

// ─── Helpers ────────────────────────────────────────────────────

function fetchJSON(url: string): unknown {
  const result = execSync(
    `curl -s --connect-timeout 10 --max-time 20 '${url}'`,
    { encoding: 'utf-8', timeout: 25_000 },
  );
  return JSON.parse(result);
}

/**
 * Extract GitHub repo full name from a URL.
 * Matches: github.com/owner/repo (ignoring trailing paths like /tree/main etc.)
 */
function extractGitHubRepo(url?: string): string | null {
  if (!url) return null;
  const match = url.match(/github\.com\/([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)/);
  if (!match) return null;
  // Clean trailing .git or similar
  return match[1]!.replace(/\.git$/, '');
}

/**
 * Extract GitHub repos mentioned in text (comments, Show HN descriptions).
 */
function extractGitHubReposFromText(text?: string): string[] {
  if (!text) return [];
  const pattern = /github\.com\/([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)/g;
  const repos: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    repos.push(m[1]!.replace(/\.git$/, ''));
  }
  return [...new Set(repos)];
}

// ─── HN Collector ───────────────────────────────────────────────

export class HNCollector {
  private config: HNCollectorConfig;

  constructor(config?: Partial<HNCollectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Fetch a single HN item by ID.
   */
  private fetchItem(id: number): HNItem | null {
    try {
      const data = fetchJSON(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      return data as HNItem;
    } catch {
      return null;
    }
  }

  /**
   * Fetch a list of story IDs from an endpoint.
   */
  private fetchStoryIds(endpoint: 'topstories' | 'newstories' | 'beststories', limit: number): number[] {
    try {
      const ids = fetchJSON(`https://hacker-news.firebaseio.com/v0/${endpoint}.json`) as number[];
      return ids.slice(0, limit);
    } catch {
      return [];
    }
  }

  /**
   * Scan stories for GitHub repo mentions.
   */
  private scanStories(
    ids: number[],
    source: string,
  ): HNRepoMention[] {
    const mentions: HNRepoMention[] = [];
    const cutoffTime = Date.now() / 1000 - this.config.maxAgeHours * 3600;

    for (const id of ids) {
      const item = this.fetchItem(id);
      if (!item || !item.time || item.time < cutoffTime) continue;
      if (item.type !== 'story') continue;

      // Check direct URL link to GitHub
      const repoFromUrl = extractGitHubRepo(item.url);
      if (repoFromUrl) {
        const isShowHN = item.title?.startsWith('Show HN:') ?? false;
        mentions.push({
          item,
          repoFullName: repoFromUrl,
          mentionType: isShowHN ? 'show_hn' : 'direct_link',
        });
        continue;
      }

      // Check text body for GitHub mentions (self-posts, Show HN with text)
      const reposFromText = extractGitHubReposFromText(item.text);
      for (const repo of reposFromText) {
        mentions.push({
          item,
          repoFullName: repo,
          mentionType: 'discussion',
        });
      }
    }

    return mentions;
  }

  /**
   * Run a full HN collection cycle.
   * Returns WorldEvents for each GitHub repo mention found on HN.
   */
  async collect(): Promise<WorldEvent[]> {
    const allMentions = new Map<string, HNRepoMention[]>(); // repo -> mentions

    // Scan top, new, and best stories
    const topIds = this.fetchStoryIds('topstories', this.config.topStoriesLimit);
    const newIds = this.fetchStoryIds('newstories', this.config.newStoriesLimit);
    const bestIds = this.fetchStoryIds('beststories', this.config.bestStoriesLimit);

    const sources = [
      { ids: topIds, label: 'hn:top' },
      { ids: newIds, label: 'hn:new' },
      { ids: bestIds, label: 'hn:best' },
    ];

    for (const { ids, label } of sources) {
      const mentions = this.scanStories(ids, label);
      for (const m of mentions) {
        const existing = allMentions.get(m.repoFullName) ?? [];
        existing.push(m);
        allMentions.set(m.repoFullName, existing);
      }
    }

    // Convert to WorldEvents
    const events: WorldEvent[] = [];

    for (const [repoFullName, mentions] of allMentions) {
      const entityId = makeEntityId('repo', repoFullName);

      // Aggregate signals
      if (mentions.length === 0) continue;
      const first = mentions[0]!;
      const topMention = mentions.reduce((best, m) =>
        (m.item.score ?? 0) > (best.item.score ?? 0) ? m : best,
        first,
      );

      const totalScore = mentions.reduce((sum, m) => sum + (m.item.score ?? 0), 0);
      const totalComments = mentions.reduce((sum, m) => sum + (m.item.descendants ?? 0), 0);
      const hasShowHN = mentions.some(m => m.mentionType === 'show_hn');
      const mentionCount = mentions.length;

      // Importance: based on HN score + comments + mention count
      const importance = Math.min(1, (
        totalScore / 500 * 0.4 +
        totalComments / 200 * 0.3 +
        mentionCount / 5 * 0.2 +
        (hasShowHN ? 0.1 : 0)
      ));

      events.push(createEvent({
        type: 'hn_mention',
        source: 'collector:hn',
        entities: [entityId],
        data: {
          repoFullName,
          hnStoryId: topMention.item.id,
          hnTitle: topMention.item.title,
          hnUrl: topMention.item.url,
          hnScore: totalScore,
          hnComments: totalComments,
          hnMentionCount: mentionCount,
          hasShowHN,
          mentionType: topMention.mentionType,
          hnPostTime: topMention.item.time
            ? new Date(topMention.item.time * 1000).toISOString()
            : null,
          allMentions: mentions.map(m => ({
            storyId: m.item.id,
            title: m.item.title,
            score: m.item.score,
            comments: m.item.descendants,
            type: m.mentionType,
          })),
        },
        importance,
      }));
    }

    // Sort by importance descending
    events.sort((a, b) => b.importance - a.importance);

    return events;
  }
}

/**
 * New Repo Scanner
 * 
 * Discovers newly created GitHub repos that show early traction signals.
 * Strategy: search for repos created in the last N days with any stars,
 * then rank by star velocity (stars per day since creation).
 * 
 * This catches repos BEFORE they hit trending — the prediction sweet spot.
 */

import { execSync } from 'node:child_process';
import { createEvent, type WorldEvent } from '../types/event.js';
import { makeEntityId, type RepoMetadata } from '../types/entity.js';

// ─── Types ──────────────────────────────────────────────────────

export interface NewRepoScannerConfig {
  token?: string;
  /** Days back to search for new repos (default: 14) */
  lookbackDays: number;
  /** Minimum stars to consider (filters noise) */
  minStars: number;
  /** Maximum repos to return per scan */
  maxResults: number;
  /** How many top repos to enrich with README/issues/etc. */
  enrichTop: number;
}

const DEFAULT_CONFIG: NewRepoScannerConfig = {
  token: process.env['GITHUB_TOKEN'],
  lookbackDays: 14,
  minStars: 10,
  maxResults: 50,
  enrichTop: 15,
};

// ─── Helpers ────────────────────────────────────────────────────

function ghApiFetch(path: string, token?: string): unknown {
  const url = `https://api.github.com${path}`;
  const headers = [
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'User-Agent: WorldMind/0.1',
  ];
  if (token) {
    headers.push('-H', `Authorization: Bearer ${token}`);
  }
  const result = execSync(
    `curl -s --connect-timeout 15 --max-time 30 ${headers.map(h => `'${h}'`).join(' ')} '${url}'`,
    { encoding: 'utf-8', timeout: 35_000 },
  );
  return JSON.parse(result);
}

// ─── Scanner ────────────────────────────────────────────────────

export class NewRepoScanner {
  private config: NewRepoScannerConfig;

  constructor(config?: Partial<NewRepoScannerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Scan for newly created repos with early traction.
   * Uses multiple search queries to cover different star ranges.
   */
  async scan(): Promise<WorldEvent[]> {
    const cutoffDate = new Date(Date.now() - this.config.lookbackDays * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);

    // Multiple queries to cover different velocity tiers
    const queries = [
      // High velocity: already >100 stars in <14 days — strong signal
      { stars: '100', sort: 'stars' as const, label: 'high_velocity' },
      // Medium velocity: 30-100 stars — interesting candidates
      { stars: '30..100', sort: 'stars' as const, label: 'medium_velocity' },
      // Early signal: 10-30 stars but recently updated — could be growing
      { stars: `${this.config.minStars}..30`, sort: 'updated' as const, label: 'early_signal' },
    ];

    const allRepos = new Map<string, { repo: any; tier: string }>();

    for (const { stars, sort, label } of queries) {
      try {
        const q = encodeURIComponent(`created:>${cutoffDate} stars:${stars} fork:false`);
        const data = ghApiFetch(
          `/search/repositories?q=${q}&sort=${sort}&order=desc&per_page=30`,
          this.config.token,
        ) as { items: any[]; total_count: number };

        for (const repo of (data.items ?? [])) {
          if (!allRepos.has(repo.full_name)) {
            allRepos.set(repo.full_name, { repo, tier: label });
          }
        }
      } catch (err) {
        console.error(`  ⚠️ Search query failed for tier ${label}:`, err);
      }
    }

    // Sort all repos by star velocity
    const sorted = [...allRepos.values()]
      .map(({ repo, tier }) => {
        const createdDate = new Date(repo.created_at);
        const daysSinceCreation = Math.max(0.5, (Date.now() - createdDate.getTime()) / (24 * 60 * 60 * 1000));
        const starsPerDay = (repo.stargazers_count ?? 0) / daysSinceCreation;
        return { repo, tier, starsPerDay, daysSinceCreation };
      })
      .sort((a, b) => b.starsPerDay - a.starsPerDay)
      .slice(0, this.config.maxResults);

    // Enrich top candidates
    const events: WorldEvent[] = [];
    let enrichedCount = 0;

    for (const { repo, tier, starsPerDay, daysSinceCreation } of sorted) {
      const entityId = makeEntityId('repo', repo.full_name);

      const metadata: RepoMetadata = {
        owner: repo.owner?.login ?? '',
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description,
        language: repo.language,
        topics: repo.topics ?? [],
        stars: repo.stargazers_count ?? 0,
        forks: repo.forks_count ?? 0,
        openIssues: repo.open_issues_count ?? 0,
        watchers: repo.watchers_count ?? 0,
        license: repo.license?.spdx_id ?? null,
        createdAt: repo.created_at ?? '',
        updatedAt: repo.updated_at ?? '',
        homepage: repo.homepage ?? null,
        isArchived: repo.archived ?? false,
        isFork: repo.fork ?? false,
        defaultBranch: repo.default_branch ?? 'main',
      };

      // Enrich top repos with README, issues, etc.
      let enrichment: Record<string, unknown> = {};
      if (enrichedCount < this.config.enrichTop) {
        enrichment = this.enrichRepo(metadata.owner, metadata.name);
        enrichedCount++;
      }

      // Importance: primarily star velocity, modified by tier
      const tierBonus = tier === 'high_velocity' ? 0.2 : tier === 'medium_velocity' ? 0.1 : 0;
      const importance = Math.min(1, starsPerDay / 200 + tierBonus);

      events.push(createEvent({
        type: 'new_repo_discovered',
        source: 'collector:new-repos',
        entities: [entityId],
        data: {
          metadata,
          starsPerDay: Math.round(starsPerDay * 10) / 10,
          daysSinceCreation: Math.round(daysSinceCreation * 10) / 10,
          velocityTier: tier,
          ...enrichment,
        },
        importance,
      }));
    }

    return events;
  }

  /**
   * Enrich a repo with README content, contributor info, and commit activity.
   */
  private enrichRepo(owner: string, name: string): Record<string, unknown> {
    const enrichment: Record<string, unknown> = {};

    // README
    try {
      const readmeData = ghApiFetch(
        `/repos/${owner}/${name}/readme`,
        this.config.token,
      ) as any;
      if (readmeData?.content) {
        const readme = Buffer.from(readmeData.content, 'base64').toString('utf-8');
        enrichment['readme'] = readme.slice(0, 3000); // More generous for new repos
      }
    } catch { /* no README */ }

    // Languages breakdown
    try {
      const langs = ghApiFetch(
        `/repos/${owner}/${name}/languages`,
        this.config.token,
      ) as Record<string, number>;
      enrichment['languages'] = langs;
    } catch { /* no language data */ }

    // Recent commits (activity signal)
    try {
      const commits = ghApiFetch(
        `/repos/${owner}/${name}/commits?per_page=10`,
        this.config.token,
      ) as any[];
      if (Array.isArray(commits)) {
        enrichment['recentCommitCount'] = commits.length;
        enrichment['lastCommitDate'] = commits[0]?.commit?.author?.date ?? null;
        // Unique authors in recent commits
        const authors = new Set(commits.map(c => c.commit?.author?.name).filter(Boolean));
        enrichment['recentUniqueAuthors'] = authors.size;
      }
    } catch { /* no commit data */ }

    // Owner info (influence signal)
    try {
      const ownerData = ghApiFetch(
        `/users/${owner}`,
        this.config.token,
      ) as any;
      enrichment['ownerFollowers'] = ownerData?.followers ?? 0;
      enrichment['ownerPublicRepos'] = ownerData?.public_repos ?? 0;
      enrichment['ownerType'] = ownerData?.type ?? 'User'; // User vs Organization
    } catch { /* no owner data */ }

    return enrichment;
  }
}

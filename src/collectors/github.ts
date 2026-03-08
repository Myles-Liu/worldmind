import { execSync } from 'node:child_process';
import { createEvent, type WorldEvent } from '../types/event.js';
import { makeEntityId, type RepoMetadata } from '../types/entity.js';

// ─── Configuration ──────────────────────────────────────────────

export interface GitHubCollectorConfig {
  token?: string;
  maxTrendingRepos: number;
  maxSearchResults: number;
}

const DEFAULT_CONFIG: GitHubCollectorConfig = {
  token: process.env['GITHUB_TOKEN'],
  maxTrendingRepos: 30,
  maxSearchResults: 50,
};

// ─── Helper: fetch GitHub API via curl (proxy-friendly) ─────────

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

// ─── GitHub Data Collector ──────────────────────────────────────

export class GitHubCollector {
  private config: GitHubCollectorConfig;

  constructor(config?: Partial<GitHubCollectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Collect trending repos by searching for recently created repos with high star counts.
   * GitHub doesn't have an official trending API, so we approximate via search.
   */
  async collectTrending(): Promise<WorldEvent[]> {
    const events: WorldEvent[] = [];

    // Search for repos created in the last 7 days with high stars
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const q = encodeURIComponent(`created:>${oneWeekAgo} stars:>50`);
    const data = ghApiFetch(
      `/search/repositories?q=${q}&sort=stars&order=desc&per_page=${this.config.maxTrendingRepos}`,
      this.config.token,
    ) as { items: any[] };

    // Sort by stars descending for enrichment prioritization
    const sortedItems = [...data.items].sort(
      (a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0),
    );

    let enrichedCount = 0;

    for (const repo of sortedItems) {
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

      // Calculate days since creation for star velocity
      const createdDate = new Date(repo.created_at ?? Date.now());
      const daysSinceCreation = Math.max(1, (Date.now() - createdDate.getTime()) / (24 * 60 * 60 * 1000));
      const starsPerDay = (repo.stargazers_count ?? 0) / daysSinceCreation;

      const importance = Math.min(1, starsPerDay / 100); // Normalize: 100+ stars/day = max importance

      // Only enrich the top 10 repos (by stars) to avoid hitting API rate limits
      let enrichment: Record<string, unknown> = {};
      if (enrichedCount < 10) {
        enrichment = this.enrichRepoData(metadata.owner, metadata.name);
        enrichedCount++;
      }

      events.push(createEvent({
        type: 'repo_trending',
        source: 'collector:github',
        entities: [entityId],
        data: { metadata, starsPerDay: Math.round(starsPerDay * 10) / 10, ...enrichment },
        importance,
      }));
    }

    return events;
  }

  /**
   * Enrich a repo with additional data: README, recent issues, contributors, recent commits.
   */
  private enrichRepoData(owner: string, name: string): Record<string, unknown> {
    const enrichment: Record<string, unknown> = {};

    try {
      // Get README
      const readmeData = ghApiFetch(`/repos/${owner}/${name}/readme`, this.config.token) as any;
      if (readmeData?.content) {
        const readme = Buffer.from(readmeData.content, 'base64').toString('utf-8');
        enrichment['readme'] = readme.slice(0, 2000);
      }
    } catch { /* README not available */ }

    try {
      // Get recent issues count (last 7 days)
      const oneWeekAgoDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const issuesData = ghApiFetch(
        `/search/issues?q=repo:${owner}/${name}+created:>${oneWeekAgoDate}&per_page=1`,
        this.config.token,
      ) as any;
      enrichment['recentIssuesCount'] = issuesData?.total_count ?? 0;
    } catch { /* Issues not available */ }

    try {
      // Get contributors count
      const contribData = ghApiFetch(
        `/repos/${owner}/${name}/contributors?per_page=1&anon=true`,
        this.config.token,
      ) as any;
      enrichment['hasMultipleContributors'] = Array.isArray(contribData) && contribData.length > 1;
    } catch { /* Contributors not available */ }

    try {
      // Get recent commits (last 7 days)
      const oneWeekAgoISO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const commitsData = ghApiFetch(
        `/repos/${owner}/${name}/commits?since=${oneWeekAgoISO}&per_page=5`,
        this.config.token,
      ) as any;
      enrichment['recentCommitCount'] = Array.isArray(commitsData) ? commitsData.length : 0;
    } catch { /* Commits not available */ }

    return enrichment;
  }

  /**
   * Collect recent events from the GitHub public events API.
   */
  async collectPublicEvents(): Promise<WorldEvent[]> {
    // TODO: Implement public events collection
    // - Fetch from /events endpoint
    // - Filter for relevant event types (WatchEvent, ForkEvent, CreateEvent)
    // - Convert to WorldEvent[]
    return [];
  }

  /**
   * Fetch detailed info about a specific repo.
   */
  async fetchRepoDetails(owner: string, repo: string): Promise<{
    metadata: RepoMetadata;
    events: WorldEvent[];
  }> {
    const data = ghApiFetch(`/repos/${owner}/${repo}`, this.config.token) as any;

    const metadata: RepoMetadata = {
      owner: data.owner.login,
      name: data.name,
      fullName: data.full_name,
      description: data.description,
      language: data.language,
      topics: data.topics ?? [],
      stars: data.stargazers_count,
      forks: data.forks_count,
      openIssues: data.open_issues_count,
      watchers: data.watchers_count,
      license: data.license?.spdx_id ?? null,
      createdAt: data.created_at ?? '',
      updatedAt: data.updated_at ?? '',
      homepage: data.homepage,
      isArchived: data.archived,
      isFork: data.fork,
      defaultBranch: data.default_branch,
    };

    const entityId = makeEntityId('repo', data.full_name);
    const event = createEvent({
      type: 'repo_discovered',
      source: 'collector:github',
      entities: [entityId],
      data: { metadata },
      importance: 0.5,
    });

    return { metadata, events: [event] };
  }

  /**
   * Search repos matching a query.
   */
  async searchRepos(query: string, sort: 'stars' | 'updated' = 'stars'): Promise<WorldEvent[]> {
    const events: WorldEvent[] = [];

    const q = encodeURIComponent(query);
    const data = ghApiFetch(
      `/search/repositories?q=${q}&sort=${sort}&order=desc&per_page=${this.config.maxSearchResults}`,
      this.config.token,
    ) as { items: any[] };

    for (const repo of data.items) {
      const entityId = makeEntityId('repo', repo.full_name);
      events.push(createEvent({
        type: 'repo_discovered',
        source: 'collector:github',
        entities: [entityId],
        data: {
          metadata: {
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
          },
        },
        importance: 0.5,
      }));
    }

    return events;
  }

  /**
   * Fetch stargazers with timestamps for a repo (for star velocity analysis).
   */
  async fetchStarHistory(
    owner: string,
    repo: string,
    _pages: number = 3,
  ): Promise<Array<{ user: string; starredAt: string }>> {
    // TODO: Implement star history fetching
    // - Use the star timestamps API (Accept: application/vnd.github.star+json)
    // - Return chronological list of star events
    return [];
  }

  /**
   * Run a full collection cycle.
   */
  async collect(): Promise<WorldEvent[]> {
    const events: WorldEvent[] = [];

    // Phase 1: Trending repos
    const trending = await this.collectTrending();
    events.push(...trending);

    // Phase 2: Public events
    const publicEvents = await this.collectPublicEvents();
    events.push(...publicEvents);

    return events;
  }
}

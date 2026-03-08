/**
 * Star History Collector
 *
 * Collects star-over-time data from GitHub's Stargazers API
 * (Accept: application/vnd.github.v3.star+json) which includes starred_at timestamps.
 *
 * Optimised for rate-limited environments (60 req/hr unauthenticated):
 *   - 1 request to get repo metadata + total stars
 *   - 1 request to page 1 (also reveals last page via Link header)
 *   - Strategic sampling of ~3-8 additional pages
 *   → ~5-10 requests per repo total
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ─── Types ──────────────────────────────────────────────────────

export interface StarDataPoint {
  date: string;            // YYYY-MM-DD
  cumulativeStars: number;
  dailyStars: number;      // delta from previous day
}

export interface StarHistory {
  repo: string;
  collectedAt: string;
  totalStars: number;
  dataPoints: StarDataPoint[];
  firstStarDate: string;
  peakDailyStars: number;
  peakDate: string;
  /** Raw sampled timestamps (for debugging / re-analysis) */
  sampledTimestamps: string[];
  /** Pages actually fetched */
  pagesFetched: number;
  /** Whether the data was sampled (repo has >12k stars) */
  sampled: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface RateLimitInfo {
  remaining: number;
  reset: number; // epoch seconds
}

export class RateLimitError extends Error {
  resetAt: number;
  constructor(resetEpoch: number) {
    super(`GitHub API rate limit exceeded. Resets at ${new Date(resetEpoch * 1000).toISOString()}`);
    this.name = 'RateLimitError';
    this.resetAt = resetEpoch;
  }
}

/**
 * Low-level: fetch a single stargazer page and parse Link header for pagination info.
 */
function fetchStargazerPage(
  owner: string,
  repo: string,
  page: number,
  perPage: number,
  token?: string,
): {
  stars: Array<{ user: string; starredAt: string }>;
  lastPage: number;
  rateLimit: RateLimitInfo;
} {
  const url = `https://api.github.com/repos/${owner}/${repo}/stargazers?per_page=${perPage}&page=${page}`;
  const headers = [
    '-H', 'Accept: application/vnd.github.v3.star+json',
    '-H', 'User-Agent: WorldMind/0.1',
  ];
  if (token) {
    headers.push('-H', `Authorization: Bearer ${token}`);
  }

  // Write headers to file to parse Link/rate-limit
  const headerFile = '/tmp/_gh_star_headers';
  const cmd = `curl -s -D '${headerFile}' --connect-timeout 15 --max-time 30 ${headers.map(h => `'${h}'`).join(' ')} '${url}'`;

  let body: string;
  try {
    body = execSync(cmd, { encoding: 'utf-8', timeout: 35_000 });
  } catch {
    body = '[]';
  }

  let headersText = '';
  try { headersText = execSync(`cat '${headerFile}'`, { encoding: 'utf-8' }); } catch { /* */ }

  const remaining = parseInt(headersText.match(/x-ratelimit-remaining:\s*(\d+)/i)?.[1] ?? '-1');
  const reset = parseInt(headersText.match(/x-ratelimit-reset:\s*(\d+)/i)?.[1] ?? '0');

  if (remaining === 0) {
    // Still parse what we got, but flag rate limit
    // (the response might still be valid for the request that used the last token)
  }

  // Extract last page from Link header
  let lastPage = page;
  const linkHeader = headersText.match(/link:\s*(.+)/i)?.[1] ?? '';
  const lastMatch = linkHeader.match(/page=(\d+)>;\s*rel="last"/);
  if (lastMatch) {
    lastPage = parseInt(lastMatch[1]!);
  }

  let parsed: any[];
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = [];
  }

  if (!Array.isArray(parsed)) {
    // Error object
    if ((parsed as any)?.message?.includes('rate limit')) {
      throw new RateLimitError(reset);
    }
    return { stars: [], lastPage, rateLimit: { remaining, reset } };
  }

  const stars = parsed.map((s: any) => ({
    user: s.user?.login ?? 'unknown',
    starredAt: s.starred_at ?? '',
  }));

  return { stars, lastPage, rateLimit: { remaining, reset } };
}

/**
 * Fetch repo metadata (1 API call) — returns total stars & creation date.
 */
function fetchRepoMeta(
  owner: string,
  repo: string,
  token?: string,
): { totalStars: number; createdAt: string; rateLimit: RateLimitInfo } {
  const url = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = [
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'User-Agent: WorldMind/0.1',
  ];
  if (token) {
    headers.push('-H', `Authorization: Bearer ${token}`);
  }

  const headerFile = '/tmp/_gh_meta_headers';
  const cmd = `curl -s -D '${headerFile}' --connect-timeout 15 --max-time 30 ${headers.map(h => `'${h}'`).join(' ')} '${url}'`;

  let body: string;
  try {
    body = execSync(cmd, { encoding: 'utf-8', timeout: 35_000 });
  } catch {
    return { totalStars: 0, createdAt: '', rateLimit: { remaining: 0, reset: 0 } };
  }

  let headersText = '';
  try { headersText = execSync(`cat '${headerFile}'`, { encoding: 'utf-8' }); } catch { /* */ }
  const remaining = parseInt(headersText.match(/x-ratelimit-remaining:\s*(\d+)/i)?.[1] ?? '0');
  const reset = parseInt(headersText.match(/x-ratelimit-reset:\s*(\d+)/i)?.[1] ?? '0');

  const data = JSON.parse(body);
  if (data?.message?.includes('rate limit')) {
    throw new RateLimitError(reset);
  }

  return {
    totalStars: data.stargazers_count ?? 0,
    createdAt: data.created_at ?? '',
    rateLimit: { remaining, reset },
  };
}

// ─── Star History Collector ─────────────────────────────────────

export class StarHistoryCollector {
  private token?: string;
  private dataDir: string;

  constructor(opts?: { token?: string; dataDir?: string }) {
    this.token = opts?.token ?? process.env['GITHUB_TOKEN'];
    this.dataDir = opts?.dataDir ?? 'data/star-histories';
  }

  /**
   * Check current rate limit remaining without using a request.
   */
  getRateLimit(): RateLimitInfo {
    try {
      const headerFile = '/tmp/_gh_rl_headers';
      execSync(
        `curl -s -D '${headerFile}' --connect-timeout 10 'https://api.github.com/rate_limit' -H 'User-Agent: WorldMind/0.1'${this.token ? ` -H 'Authorization: Bearer ${this.token}'` : ''}`,
        { encoding: 'utf-8', timeout: 15_000 },
      );
      const headersText = execSync(`cat '${headerFile}'`, { encoding: 'utf-8' });
      return {
        remaining: parseInt(headersText.match(/x-ratelimit-remaining:\s*(\d+)/i)?.[1] ?? '0'),
        reset: parseInt(headersText.match(/x-ratelimit-reset:\s*(\d+)/i)?.[1] ?? '0'),
      };
    } catch {
      return { remaining: 0, reset: 0 };
    }
  }

  /**
   * Collect star history for a single repo.
   *
   * API budget: ~5-10 requests per repo.
   *   - 1 for repo metadata
   *   - 1 for page 1 (gets Link header → lastPage)
   *   - 3-8 strategically sampled pages
   */
  async collect(repoFullName: string): Promise<StarHistory> {
    const [owner, repo] = repoFullName.split('/') as [string, string];

    console.log(`\n📊 Collecting star history for ${repoFullName}...`);

    // Step 1: Get repo metadata (1 request)
    const meta = fetchRepoMeta(owner, repo, this.token);
    const totalStars = meta.totalStars;
    let rateRemaining = meta.rateLimit.remaining;
    let rateReset = meta.rateLimit.reset;

    console.log(`  Stars: ${totalStars.toLocaleString()} | API remaining: ${rateRemaining}`);

    if (totalStars === 0) {
      const empty = this.emptyHistory(repoFullName);
      await this.save(empty);
      return empty;
    }

    if (rateRemaining < 2) {
      console.log(`  ⚠️ Only ${rateRemaining} API calls left. Saving empty and skipping.`);
      const empty = this.emptyHistory(repoFullName);
      empty.totalStars = totalStars;
      await this.save(empty);
      return empty;
    }

    const perPage = 100; // max per page for stargazers
    const allTimestamps: string[] = [];

    // Step 2: Fetch page 1 (1 request — also gets lastPage from Link header)
    const page1 = fetchStargazerPage(owner, repo, 1, perPage, this.token);
    rateRemaining = page1.rateLimit.remaining;
    rateReset = page1.rateLimit.reset;

    for (const s of page1.stars) {
      if (s.starredAt) allTimestamps.push(s.starredAt);
    }

    const lastPage = page1.lastPage;
    console.log(`  Last page: ${lastPage} | Got ${page1.stars.length} timestamps | API remaining: ${rateRemaining}`);

    // Step 3: Select additional pages to fetch
    const pagesToFetch = this.selectSamplePages(lastPage, rateRemaining);
    console.log(`  Sampling pages: [${pagesToFetch.join(', ')}]`);

    for (const pg of pagesToFetch) {
      if (rateRemaining <= 1) {
        console.log(`  ⚠️ API budget exhausted (${rateRemaining} left). Stopping.`);
        break;
      }

      try {
        const result = fetchStargazerPage(owner, repo, pg, perPage, this.token);
        rateRemaining = result.rateLimit.remaining;
        rateReset = result.rateLimit.reset;

        for (const s of result.stars) {
          if (s.starredAt) allTimestamps.push(s.starredAt);
        }
        await sleep(100); // be polite
      } catch (e) {
        if (e instanceof RateLimitError) {
          console.log(`  ⚠️ Rate limited. Saving partial data.`);
          break;
        }
        console.log(`  ⚠️ Error page ${pg}: ${(e as Error).message}`);
      }
    }

    console.log(`  Total timestamps collected: ${allTimestamps.length} | API remaining: ${rateRemaining}`);

    // Step 4: Build history from sampled timestamps
    const history = this.buildHistory(
      repoFullName,
      totalStars,
      allTimestamps,
      pagesToFetch.length + 1, // +1 for page 1
      lastPage > pagesToFetch.length + 1,
    );

    await this.save(history);
    return history;
  }

  /**
   * Load a previously saved star history from disk.
   */
  async loadCached(repoFullName: string): Promise<StarHistory | null> {
    const filePath = this.getFilePath(repoFullName);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as StarHistory;
    } catch {
      return null;
    }
  }

  // ─── Internal ───────────────────────────────────────────────

  /**
   * Choose which pages to sample (apart from page 1 already fetched).
   * Budget-aware: uses at most (rateRemaining - 1) pages (reserve 1 for safety).
   */
  private selectSamplePages(lastPage: number, rateRemaining: number): number[] {
    if (lastPage <= 1) return [];

    const budget = Math.min(rateRemaining - 1, 8); // max 8 additional pages
    if (budget <= 0) return [];

    const pages: Set<number> = new Set();

    if (lastPage <= budget + 1) {
      // Small repo — fetch all remaining pages
      for (let i = 2; i <= lastPage; i++) pages.add(i);
      return [...pages].sort((a, b) => a - b);
    }

    // Strategic sampling:
    //   - 1-2 early pages (growth phase)
    //   - 2-3 middle pages (steady state)
    //   - 2-3 late pages (recent, including last)

    // Early
    pages.add(2);
    if (budget >= 6 && lastPage > 10) pages.add(Math.floor(lastPage * 0.05));

    // Middle
    pages.add(Math.floor(lastPage * 0.25));
    pages.add(Math.floor(lastPage * 0.5));
    if (budget >= 7) pages.add(Math.floor(lastPage * 0.75));

    // Late
    pages.add(lastPage - 1);
    pages.add(lastPage);
    if (budget >= 5 && lastPage > 20) pages.add(lastPage - Math.floor(lastPage * 0.05));

    // Remove page 1 (already fetched) and any out of range
    pages.delete(1);
    pages.delete(0);

    // Trim to budget
    const sorted = [...pages].filter(p => p >= 2 && p <= lastPage).sort((a, b) => a - b);
    return sorted.slice(0, budget);
  }

  private buildHistory(
    repo: string,
    totalStars: number,
    timestamps: string[],
    pagesFetched: number,
    sampled: boolean,
  ): StarHistory {
    if (timestamps.length === 0) {
      return this.emptyHistory(repo, totalStars);
    }

    // Sort timestamps chronologically
    timestamps.sort();

    // Group by date
    const dateCountMap = new Map<string, number>();
    for (const ts of timestamps) {
      const date = ts.slice(0, 10);
      dateCountMap.set(date, (dateCountMap.get(date) ?? 0) + 1);
    }

    const sortedDates = [...dateCountMap.keys()].sort();

    // For sampled data: each page = perPage (100) stars.
    // We know total stars and the position of each page.
    // The daily counts from sampled data reflect the SHAPE but not absolute magnitude.
    // Scale factor = totalStars / sampledStars
    const sampledStars = timestamps.length;
    const scaleFactor = sampled ? Math.max(1, totalStars / sampledStars) : 1;

    const dataPoints: StarDataPoint[] = [];
    let cumulative = 0;
    let peakDailyStars = 0;
    let peakDate = sortedDates[0] ?? '';

    for (const date of sortedDates) {
      const rawCount = dateCountMap.get(date) ?? 0;
      const dailyStars = Math.round(rawCount * scaleFactor);
      cumulative += dailyStars;

      dataPoints.push({ date, cumulativeStars: cumulative, dailyStars });

      if (dailyStars > peakDailyStars) {
        peakDailyStars = dailyStars;
        peakDate = date;
      }
    }

    return {
      repo,
      collectedAt: new Date().toISOString(),
      totalStars,
      dataPoints,
      firstStarDate: sortedDates[0] ?? '',
      peakDailyStars,
      peakDate,
      sampledTimestamps: timestamps,
      pagesFetched,
      sampled,
    };
  }

  private emptyHistory(repo: string, totalStars = 0): StarHistory {
    return {
      repo,
      collectedAt: new Date().toISOString(),
      totalStars,
      dataPoints: [],
      firstStarDate: '',
      peakDailyStars: 0,
      peakDate: '',
      sampledTimestamps: [],
      pagesFetched: 0,
      sampled: false,
    };
  }

  private getFilePath(repoFullName: string): string {
    const safe = repoFullName.replace('/', '__');
    return path.join(this.dataDir, `${safe}.json`);
  }

  private async save(history: StarHistory): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const filePath = this.getFilePath(history.repo);
    await fs.writeFile(filePath, JSON.stringify(history, null, 2));
    console.log(`  💾 Saved to ${filePath}`);
  }
}

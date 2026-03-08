/**
 * Discovery Pipeline
 * 
 * Aggregates signals from multiple collectors (GitHub new repos, HN, etc.)
 * to produce a ranked list of candidate repos for Agent analysis.
 * 
 * This is the "perception layer" of WorldMind for the GitHub domain adapter.
 * The pipeline:
 *   1. Scan multiple sources for repo mentions/discoveries
 *   2. Deduplicate and merge signals per repo
 *   3. Compute a composite "discovery score"
 *   4. Rank and return top candidates for Agent evaluation
 */

import { NewRepoScanner, type NewRepoScannerConfig } from './new-repos.js';
import { HNCollector, type HNCollectorConfig } from './hn.js';
import { GitHubCollector, type GitHubCollectorConfig } from './github.js';
import type { WorldEvent } from '../types/event.js';
import { makeEntityId } from '../types/entity.js';

// ─── Types ──────────────────────────────────────────────────────

export interface RepoCandidate {
  repoFullName: string;
  entityId: string;

  // Signals
  signals: {
    /** From NewRepoScanner */
    newRepo?: {
      stars: number;
      starsPerDay: number;
      daysSinceCreation: number;
      velocityTier: string;
      description: string | null;
      language: string | null;
      topics: string[];
      readme?: string;
      ownerFollowers?: number;
      ownerType?: string;
      recentCommitCount?: number;
      recentUniqueAuthors?: number;
      languages?: Record<string, number>;
    };

    /** From HNCollector */
    hn?: {
      score: number;
      comments: number;
      mentionCount: number;
      hasShowHN: boolean;
      title: string;
      postTime: string | null;
    };

    /** From GitHubCollector (existing trending) */
    trending?: {
      stars: number;
      starsPerDay: number;
    };
  };

  // Composite scores
  discoveryScore: number;       // 0-1, overall "will this be big?" signal
  signalSources: string[];      // which collectors found this
  firstSeenAt: string;          // ISO timestamp
}

export interface DiscoveryResult {
  candidates: RepoCandidate[];
  scanTimestamp: string;
  stats: {
    totalNewRepos: number;
    totalHNMentions: number;
    totalTrending: number;
    uniqueRepos: number;
    multiSignalRepos: number;  // repos seen in 2+ sources — strongest signal
  };
}

export interface DiscoveryConfig {
  newRepos?: Partial<NewRepoScannerConfig>;
  hn?: Partial<HNCollectorConfig>;
  github?: Partial<GitHubCollectorConfig>;
  /** Max candidates to return */
  maxCandidates: number;
  /** Minimum discovery score to include */
  minScore: number;
}

const DEFAULT_CONFIG: DiscoveryConfig = {
  maxCandidates: 30,
  minScore: 0.05,
};

// ─── Discovery Pipeline ─────────────────────────────────────────

export class DiscoveryPipeline {
  private newRepoScanner: NewRepoScanner;
  private hnCollector: HNCollector;
  private githubCollector: GitHubCollector;
  private config: DiscoveryConfig;

  constructor(config?: Partial<DiscoveryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.newRepoScanner = new NewRepoScanner(config?.newRepos);
    this.hnCollector = new HNCollector(config?.hn);
    this.githubCollector = new GitHubCollector(config?.github);
  }

  /**
   * Run a full discovery cycle.
   */
  async discover(): Promise<DiscoveryResult> {
    const scanTimestamp = new Date().toISOString();

    // Phase 1: Collect from all sources in parallel-ish (sequential for rate limits)
    console.log('  📡 Scanning new repos...');
    const newRepoEvents = await this.newRepoScanner.scan();
    console.log(`     Found ${newRepoEvents.length} new repos with traction`);

    console.log('  📡 Scanning Hacker News...');
    const hnEvents = await this.hnCollector.collect();
    console.log(`     Found ${hnEvents.length} GitHub mentions on HN`);

    console.log('  📡 Scanning GitHub trending...');
    const trendingEvents = await this.githubCollector.collectTrending();
    console.log(`     Found ${trendingEvents.length} trending repos`);

    // Phase 2: Merge signals per repo
    const repoMap = new Map<string, RepoCandidate>();

    // Process new repo events
    for (const event of newRepoEvents) {
      const data = event.data as any;
      const fullName = data.metadata?.fullName;
      if (!fullName) continue;

      const candidate = this.getOrCreate(repoMap, fullName, scanTimestamp);
      candidate.signals.newRepo = {
        stars: data.metadata.stars,
        starsPerDay: data.starsPerDay,
        daysSinceCreation: data.daysSinceCreation,
        velocityTier: data.velocityTier,
        description: data.metadata.description,
        language: data.metadata.language,
        topics: data.metadata.topics ?? [],
        readme: data.readme,
        ownerFollowers: data.ownerFollowers,
        ownerType: data.ownerType,
        recentCommitCount: data.recentCommitCount,
        recentUniqueAuthors: data.recentUniqueAuthors,
        languages: data.languages,
      };
      if (!candidate.signalSources.includes('new-repos')) {
        candidate.signalSources.push('new-repos');
      }
    }

    // Process HN events
    for (const event of hnEvents) {
      const data = event.data as any;
      const fullName = data.repoFullName;
      if (!fullName) continue;

      const candidate = this.getOrCreate(repoMap, fullName, scanTimestamp);
      candidate.signals.hn = {
        score: data.hnScore,
        comments: data.hnComments,
        mentionCount: data.hnMentionCount,
        hasShowHN: data.hasShowHN,
        title: data.hnTitle,
        postTime: data.hnPostTime,
      };
      if (!candidate.signalSources.includes('hn')) {
        candidate.signalSources.push('hn');
      }
    }

    // Process trending events
    for (const event of trendingEvents) {
      const data = event.data as any;
      const fullName = data.metadata?.fullName;
      if (!fullName) continue;

      const candidate = this.getOrCreate(repoMap, fullName, scanTimestamp);
      candidate.signals.trending = {
        stars: data.metadata?.stars ?? 0,
        starsPerDay: data.starsPerDay ?? 0,
      };
      if (!candidate.signalSources.includes('trending')) {
        candidate.signalSources.push('trending');
      }
    }

    // Phase 3: Score and rank
    for (const candidate of repoMap.values()) {
      candidate.discoveryScore = this.computeScore(candidate);
    }

    const candidates = [...repoMap.values()]
      .filter(c => c.discoveryScore >= this.config.minScore)
      .sort((a, b) => b.discoveryScore - a.discoveryScore)
      .slice(0, this.config.maxCandidates);

    // Stats
    const multiSignalRepos = candidates.filter(c => c.signalSources.length >= 2).length;

    return {
      candidates,
      scanTimestamp,
      stats: {
        totalNewRepos: newRepoEvents.length,
        totalHNMentions: hnEvents.length,
        totalTrending: trendingEvents.length,
        uniqueRepos: repoMap.size,
        multiSignalRepos,
      },
    };
  }

  /**
   * Get or create a candidate entry for a repo.
   */
  private getOrCreate(
    map: Map<string, RepoCandidate>,
    repoFullName: string,
    scanTimestamp: string,
  ): RepoCandidate {
    let candidate = map.get(repoFullName);
    if (!candidate) {
      candidate = {
        repoFullName,
        entityId: makeEntityId('repo', repoFullName),
        signals: {},
        discoveryScore: 0,
        signalSources: [],
        firstSeenAt: scanTimestamp,
      };
      map.set(repoFullName, candidate);
    }
    return candidate;
  }

  /**
   * Compute composite discovery score from all signals.
   * 
   * Score components:
   *   - Star velocity (0-0.3): How fast is it getting stars?
   *   - HN signal (0-0.25): HN exposure = massive potential audience
   *   - Multi-source bonus (0-0.15): Seen in 2+ sources = confirmed signal
   *   - Quality signals (0-0.15): README exists, active development, topics
   *   - Author influence (0-0.15): Big-name author = guaranteed eyeballs
   */
  private computeScore(c: RepoCandidate): number {
    let score = 0;

    // ── Star velocity (0-0.3) ──
    const starsPerDay = c.signals.newRepo?.starsPerDay
      ?? c.signals.trending?.starsPerDay
      ?? 0;
    score += Math.min(0.3, starsPerDay / 500 * 0.3);

    // ── HN signal (0-0.25) ──
    if (c.signals.hn) {
      const hnScore = c.signals.hn.score;
      const hnComments = c.signals.hn.comments;
      const showHNBonus = c.signals.hn.hasShowHN ? 0.05 : 0;
      score += Math.min(0.25, (
        hnScore / 500 * 0.12 +
        hnComments / 200 * 0.08 +
        showHNBonus
      ));
    }

    // ── Multi-source bonus (0-0.15) ──
    if (c.signalSources.length >= 3) {
      score += 0.15;
    } else if (c.signalSources.length >= 2) {
      score += 0.10;
    }

    // ── Quality signals (0-0.15) ──
    if (c.signals.newRepo) {
      const nr = c.signals.newRepo;
      // Has README
      if (nr.readme && nr.readme.length > 200) score += 0.03;
      // Has topics/tags
      if (nr.topics.length >= 2) score += 0.02;
      // Active development (multiple authors)
      if ((nr.recentUniqueAuthors ?? 0) >= 2) score += 0.03;
      // Recent commits
      if ((nr.recentCommitCount ?? 0) >= 5) score += 0.02;
      // Has description
      if (nr.description && nr.description.length > 20) score += 0.02;
      // Has license
      // (checked via metadata, not directly available here but could be added)
      // Hot topic alignment (AI, LLM, Rust, etc.)
      const hotTopics = ['llm', 'ai', 'rust', 'agent', 'ml', 'gpt', 'local-first', 'wasm'];
      const topicMatch = nr.topics.some(t => hotTopics.includes(t.toLowerCase()));
      if (topicMatch) score += 0.03;
    }

    // ── Author influence (0-0.15) ──
    const followers = c.signals.newRepo?.ownerFollowers ?? 0;
    if (followers > 10000) {
      score += 0.15;
    } else if (followers > 1000) {
      score += 0.10;
    } else if (followers > 100) {
      score += 0.05;
    }

    return Math.min(1, score);
  }
}

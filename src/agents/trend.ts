import { BaseAgent } from './base-agent.js';
import type { AgentOutput } from '../types/agent.js';
import type { WorldEvent } from '../types/event.js';

// ─── Types ──────────────────────────────────────────────────────

interface RepoSummary {
  repoFullName: string;
  entityId: string;
  data: Record<string, unknown>;
}

interface BatchTrendResult {
  assessments: Array<{
    repo: string;
    isTrending: boolean;
    confidence: number;
    category: string;
    reasoning: string;
    predictedGrowth: string;
    keyFactors: string[];
    estimatedStars30d: number;
  }>;
}

// ─── Trend Agent ────────────────────────────────────────────────

export class TrendAgent extends BaseAgent {
  readonly name = 'trend';
  readonly description =
    'Monitors GitHub trending data and identifies repos with abnormal growth patterns';

  async analyze(events: WorldEvent[]): Promise<AgentOutput[]> {
    await this.initialize();

    const relevantEvents = events.filter(
      (e) =>
        e.type === 'repo_trending' ||
        e.type === 'repo_discovered' ||
        e.type === 'repo_stars_updated' ||
        e.type === 'new_repo_discovered' ||
        e.type === 'hn_mention',
    );

    if (relevantEvents.length === 0) {
      await this.finalize();
      return [];
    }

    // Deduplicate by repo name, keep highest-importance event per repo
    const repoMap = new Map<string, WorldEvent>();
    for (const e of relevantEvents) {
      const name = (e.data['metadata'] as any)?.fullName ?? e.data['repoFullName'] as string;
      if (!name) continue;
      const existing = repoMap.get(name);
      if (!existing || e.importance > existing.importance) {
        repoMap.set(name, e);
      }
    }

    const repos = [...repoMap.entries()]
      .sort((a, b) => b[1].importance - a[1].importance)
      .slice(0, 10);

    // Build batch summary for all repos
    const repoSummaries: RepoSummary[] = repos.map(([name, event]) => ({
      repoFullName: name,
      entityId: event.entities[0] ?? '',
      data: event.data,
    }));

    // Single LLM call for all repos
    const outputs = await this.batchAnalyze(repoSummaries);

    if (outputs.length > 0) {
      const topSignals = outputs
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 3)
        .map(o => `${o.data['repo']} (${o.data['predictedGrowth']})`);
      this.memory.add({
        cycle: 0,
        type: 'observation',
        content: `Found ${outputs.length} trend signals from ${repos.length} repos. Top: ${topSignals.join(', ')}`,
        importance: 0.7,
      });
    }

    await this.finalize();
    return outputs;
  }

  /**
   * Batch-analyze all repos in a single LLM call.
   */
  private async batchAnalyze(repos: RepoSummary[]): Promise<AgentOutput[]> {
    // Build per-repo data blocks
    const repoBlocks = repos.map((r, i) => {
      const d = r.data;
      const m = d['metadata'] as any;
      const parts: string[] = [`--- Repo ${i + 1}: ${r.repoFullName} ---`];

      if (m) {
        if (m.description) parts.push(`Description: ${m.description}`);
        if (m.language) parts.push(`Language: ${m.language}`);
        if (m.topics?.length) parts.push(`Topics: ${m.topics.join(', ')}`);
        parts.push(`Stars: ${m.stars ?? '?'}`);
        if (m.forks) parts.push(`Forks: ${m.forks}`);
      }
      if (d['starsPerDay'] != null) parts.push(`Stars/day: ${d['starsPerDay']}`);
      if (d['daysSinceCreation'] != null) parts.push(`Age: ${d['daysSinceCreation']} days`);
      if (d['velocityTier']) parts.push(`Velocity tier: ${d['velocityTier']}`);
      if (d['ownerFollowers'] != null) parts.push(`Owner followers: ${d['ownerFollowers']}`);
      if (d['recentCommitCount'] != null) parts.push(`Recent commits: ${d['recentCommitCount']}`);
      if (d['recentUniqueAuthors'] != null) parts.push(`Unique authors: ${d['recentUniqueAuthors']}`);

      // HN signals
      if (d['hnScore'] != null) {
        parts.push(`HN score: ${d['hnScore']}, comments: ${d['hnComments']}, title: "${d['hnTitle']}"`);
      }

      // README (truncated)
      if (d['readme']) {
        const readme = String(d['readme']).slice(0, 500);
        parts.push(`README: ${readme}`);
      }

      return parts.join('\n');
    });

    const allTopics = repos.flatMap(r => {
      const m = r.data['metadata'] as any;
      return [r.repoFullName, m?.language, ...(m?.topics || [])].filter(Boolean);
    });

    const systemPrompt = this.buildSystemPrompt({
      taskDescription: `Assess each repository below. For each, determine if it represents a significant trend. Be ruthless — most repos are noise. Only flag genuine signals.`,
      topics: allTopics,
      responseFormat: `{
  "assessments": [
    {
      "repo": "owner/name",
      "isTrending": true/false,
      "confidence": 0.0-1.0,
      "category": "ai|devtools|framework|library|app|other",
      "reasoning": "brief, no fluff",
      "predictedGrowth": "explosive|fast|moderate|slow",
      "keyFactors": ["factor1", "factor2"],
      "estimatedStars30d": number
    }
  ]
}`,
    });

    const userPrompt = `Analyze these ${repos.length} repositories:\n\n${repoBlocks.join('\n\n')}`;

    try {
      const result = await this.llm.json<BatchTrendResult>(systemPrompt, userPrompt);
      const outputs: AgentOutput[] = [];

      for (const a of result.assessments) {
        if (!a.isTrending || a.confidence < this.config.confidenceThreshold) continue;

        const match = repos.find(r => r.repoFullName === a.repo);
        const entityId = match?.entityId ? [match.entityId] : [];
        const m = match?.data['metadata'] as any;

        outputs.push(
          this.createOutput(
            'trend_signal',
            {
              repo: a.repo,
              stars: m?.stars ?? 0,
              starsPerDay: match?.data['starsPerDay'],
              category: a.category,
              predictedGrowth: a.predictedGrowth,
              keyFactors: a.keyFactors,
              estimatedStars30d: a.estimatedStars30d,
            },
            a.confidence,
            a.reasoning,
            entityId,
          ),
        );
      }

      return outputs;
    } catch (err) {
      console.error(`  [TrendAgent] Batch LLM error: ${err}`);
      return [];
    }
  }

  override filterEvents(events: WorldEvent[]): WorldEvent[] {
    return super.filterEvents(events).filter(
      (e) => e.source === 'collector:github'
        || e.source === 'collector:new-repos'
        || e.source === 'collector:hn'
        || e.source === 'agent:network',
    );
  }
}

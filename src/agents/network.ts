import { BaseAgent } from './base-agent.js';
import type { AgentOutput } from '../types/agent.js';
import type { WorldEvent } from '../types/event.js';

// ─── Types ──────────────────────────────────────────────────────

interface RepoInfo {
  fullName: string;
  owner: string;
  language: string | null;
  topics: string[];
  stars: number;
  forks: number;
  description: string | null;
  isFork: boolean;
}

interface NetworkAnalysis {
  clusters: Array<{
    theme: string;
    repos: string[];
    relationship: 'competing' | 'complementary' | 'ecosystem' | 'same_org';
  }>;
  keyPlayers: Array<{
    repo: string;
    role: 'leader' | 'challenger' | 'emerging' | 'niche';
    reasoning: string;
  }>;
  insights: string[];
}

// ─── Network Agent ──────────────────────────────────────────────

export class NetworkAgent extends BaseAgent {
  readonly name = 'network';
  readonly description =
    'Builds and maintains developer/project relationship graphs, identifies communities and influencers';

  protected override autoSummary(
    _outputType: string,
    data: Record<string, unknown>,
    confidence: number,
  ): string {
    const clusters = (data['clusters'] as any[]) ?? [];
    const insights = (data['insights'] as string[]) ?? [];
    if (clusters.length === 0 && insights.length > 0) return insights[0]!.slice(0, 100);
    return `${clusters.length} cluster(s), ${Math.round(confidence * 100)}% conf`;
  }

  /**
   * Analyze events for network/relationship changes.
   */
  async analyze(events: WorldEvent[]): Promise<AgentOutput[]> {
    await this.initialize();

    // Extract repos from all relevant events
    const repos = this.extractRepos(events);

    if (repos.length < 2) {
      await this.finalize();
      return [];
    }

    // Build relationship data
    const ownerGroups = this.groupByOwner(repos);
    const languageGroups = this.groupByLanguage(repos);
    const topicOverlaps = this.findTopicOverlaps(repos);
    const forkRepos = repos.filter((r) => r.isFork);

    // If no structural relationships exist, skip LLM call entirely.
    // Don't ask the model to hallucinate relationships from nothing.
    const hasMultiOwner = Object.values(ownerGroups).some(g => g.length > 1);
    const hasTopicOverlap = topicOverlaps.length > 0;
    const hasForks = forkRepos.length > 0;
    if (!hasMultiOwner && !hasTopicOverlap && !hasForks) {
      // Return a minimal structural output without LLM
      const entityIds = repos.map(r => `repo:${r.fullName}`);
      await this.finalize();
      return [this.createOutput(
        'network_update',
        {
          clusters: [],
          keyPlayers: repos.slice(0, 5).map(r => ({ repo: r.fullName, role: 'independent' })),
          insights: ['No structural relationships detected between repos'],
          repoCount: repos.length,
        },
        0.3,
        'No structural relationships — repos are independent',
        entityIds,
        `${repos.length} repos analyzed, no structural overlap detected`,
      )];
    }

    // Build a summary for LLM analysis
    const repoSummary = repos
      .slice(0, 30) // Limit to top 30 for prompt size
      .map(
        (r) =>
          `- ${r.fullName}: ${r.description ?? 'No description'} | Lang: ${r.language ?? 'Unknown'} | Stars: ${r.stars} | Topics: ${r.topics.join(', ') || 'None'}`,
      )
      .join('\n');

    const relationshipContext = [
      `Owner groups (repos by same org/user): ${Object.entries(ownerGroups)
        .filter(([, repos]) => repos.length > 1)
        .map(([owner, repos]) => `${owner}: ${repos.map((r) => r.fullName).join(', ')}`)
        .join('; ') || 'None'}`,
      `Language groups: ${Object.entries(languageGroups)
        .filter(([lang]) => lang !== 'null')
        .map(([lang, repos]) => `${lang} (${repos.length} repos)`)
        .join(', ')}`,
      `Topic overlaps: ${topicOverlaps.slice(0, 10).map((o) => `${o.repos[0]} <-> ${o.repos[1]} (shared: ${o.sharedTopics.join(', ')})`).join('; ') || 'None'}`,
      `Fork repos: ${forkRepos.map((r) => r.fullName).join(', ') || 'None'}`,
    ].join('\n');

    // Build knowledge context from repo names, owners, languages, topics
    const knowledgeTopics = repos.flatMap(r => [r.fullName, r.owner, r.language, ...r.topics].filter(Boolean)) as string[];

    const systemPrompt = this.buildSystemPrompt({
      taskDescription: 'Analyze the relationships between trending entities. Identify clusters, key players, and ecosystem insights.',
      topics: knowledgeTopics,
      additionalContext: `Relationship signals:\n${relationshipContext}`,
      responseFormat: `{
  "clusters": [
    {
      "theme": "description of this cluster",
      "repos": ["repo1", "repo2"],
      "relationship": "competing|complementary|ecosystem|same_org"
    }
  ],
  "keyPlayers": [
    {
      "repo": "name",
      "role": "leader|challenger|emerging|niche",
      "reasoning": "why"
    }
  ],
  "insights": ["insight1", "insight2"]
}`,
    });

    const userPrompt = `Analyze the relationships between these trending entities:

Entities:
${repoSummary}

Relationship signals:
${relationshipContext}

Identify clusters, key players, and insights about the ecosystem.`;

    try {
      const analysis = await this.llm.json<NetworkAnalysis>(systemPrompt, userPrompt);

      const entityIds = repos.map((r) => `repo:${r.fullName}`);

      const outputs = [
        this.createOutput(
          'network_update',
          {
            clusters: analysis.clusters,
            keyPlayers: analysis.keyPlayers,
            insights: analysis.insights,
            repoCount: repos.length,
          },
          0.6,
          analysis.insights.join('; ') || 'Network analysis completed',
          entityIds,
          `${analysis.clusters.length} clusters, ${analysis.keyPlayers.length} key players: ${analysis.insights.slice(0, 2).map(s => s.slice(0, 80)).join('; ')}`,
        ),
      ];

      // Save to memory
      const clusterSummary = analysis.clusters
        .slice(0, 3)
        .map(c => `${c.theme} (${c.relationship})`)
        .join(', ');
      this.memory.add({
        cycle: 0,
        type: 'observation',
        content: `Analyzed ${repos.length} repos. Found ${analysis.clusters.length} clusters: ${clusterSummary}. Key insights: ${analysis.insights.slice(0, 2).join('; ')}`,
        importance: 0.6,
      });

      await this.finalize();
      return outputs;
    } catch (err) {
      console.error(`  [NetworkAgent] LLM error: ${err}`);
      await this.finalize();
      return [];
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────

  private extractRepos(events: WorldEvent[]): RepoInfo[] {
    const repoMap = new Map<string, RepoInfo>();

    for (const event of events) {
      const metadata = event.data['metadata'] as any;
      if (!metadata?.fullName) continue;

      repoMap.set(metadata.fullName, {
        fullName: metadata.fullName,
        owner: metadata.owner ?? '',
        language: metadata.language ?? null,
        topics: metadata.topics ?? [],
        stars: metadata.stars ?? 0,
        forks: metadata.forks ?? 0,
        description: metadata.description ?? null,
        isFork: metadata.isFork ?? false,
      });
    }

    return Array.from(repoMap.values()).sort((a, b) => b.stars - a.stars);
  }

  private groupByOwner(repos: RepoInfo[]): Record<string, RepoInfo[]> {
    const groups: Record<string, RepoInfo[]> = {};
    for (const repo of repos) {
      const arr = groups[repo.owner];
      if (!arr) {
        groups[repo.owner] = [repo];
      } else {
        arr.push(repo);
      }
    }
    return groups;
  }

  private groupByLanguage(repos: RepoInfo[]): Record<string, RepoInfo[]> {
    const groups: Record<string, RepoInfo[]> = {};
    for (const repo of repos) {
      const lang = repo.language ?? 'null';
      const arr = groups[lang];
      if (!arr) {
        groups[lang] = [repo];
      } else {
        arr.push(repo);
      }
    }
    return groups;
  }

  private findTopicOverlaps(
    repos: RepoInfo[],
  ): Array<{ repos: [string, string]; sharedTopics: string[] }> {
    const overlaps: Array<{ repos: [string, string]; sharedTopics: string[] }> = [];

    for (let i = 0; i < repos.length && i < 30; i++) {
      const repoI = repos[i];
      if (!repoI) continue;
      for (let j = i + 1; j < repos.length && j < 30; j++) {
        const repoJ = repos[j];
        if (!repoJ) continue;
        const shared = repoI.topics.filter((t) => repoJ.topics.includes(t));
        if (shared.length > 0) {
          overlaps.push({
            repos: [repoI.fullName, repoJ.fullName],
            sharedTopics: shared,
          });
        }
      }
    }

    return overlaps.sort((a, b) => b.sharedTopics.length - a.sharedTopics.length);
  }

  override filterEvents(events: WorldEvent[]): WorldEvent[] {
    return super.filterEvents(events).filter(
      (e) => e.source === 'collector:github',
    );
  }
}

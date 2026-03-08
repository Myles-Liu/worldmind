import { BaseAgent } from './base-agent.js';
import type { AgentOutput } from '../types/agent.js';
import type { WorldEvent } from '../types/event.js';

// ─── Types ──────────────────────────────────────────────────────

interface TechAnalysis {
  risingTechnologies: Array<{
    name: string;
    signal: string;
    confidence: number;
  }>;
  decliningTechnologies: Array<{
    name: string;
    signal: string;
    confidence: number;
  }>;
  emergingPatterns: string[];
  reasoning: string;
}

// ─── Tech Agent ─────────────────────────────────────────────────

export class TechAgent extends BaseAgent {
  readonly name = 'tech';
  readonly description =
    'Tracks technology stack and framework lifecycles, adoption curves, and migration patterns';

  /**
   * Analyze events for technology trends.
   */
  async analyze(events: WorldEvent[]): Promise<AgentOutput[]> {
    await this.initialize();

    // Extract language and topic distributions from events
    const languageCounts = new Map<string, number>();
    const topicCounts = new Map<string, number>();
    const notableRepos: Array<{ name: string; stars: number; language: string; topics: string[] }> = [];

    for (const event of events) {
      const metadata = event.data['metadata'] as any;
      if (!metadata) continue;

      // Count languages
      if (metadata.language) {
        languageCounts.set(
          metadata.language,
          (languageCounts.get(metadata.language) ?? 0) + 1,
        );
      }

      // Count topics
      const topics = (metadata.topics ?? []) as string[];
      for (const topic of topics) {
        topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
      }

      // Track notable repos
      if (metadata.fullName) {
        notableRepos.push({
          name: metadata.fullName,
          stars: metadata.stars ?? 0,
          language: metadata.language ?? 'Unknown',
          topics: topics,
        });
      }
    }

    if (languageCounts.size === 0 && topicCounts.size === 0) {
      await this.finalize();
      return [];
    }

    // Sort by count
    const sortedLanguages = [...languageCounts.entries()]
      .sort((a, b) => b[1] - a[1]);
    const sortedTopics = [...topicCounts.entries()]
      .sort((a, b) => b[1] - a[1]);
    const topRepos = notableRepos
      .sort((a, b) => b.stars - a.stars)
      .slice(0, 15);

    const languageStr = sortedLanguages
      .map(([lang, count]) => `${lang}: ${count} repos`)
      .join('\n');
    const topicStr = sortedTopics
      .slice(0, 30)
      .map(([topic, count]) => `${topic}: ${count} repos`)
      .join('\n');
    const repoStr = topRepos
      .map((r) => `- ${r.name} (${r.language}, ${r.stars} stars, topics: ${r.topics.join(', ') || 'none'})`)
      .join('\n');

    // Build knowledge context from languages, topics, and repo names
    const knowledgeTopics = [
      ...sortedLanguages.map(([lang]) => lang),
      ...sortedTopics.slice(0, 20).map(([topic]) => topic),
      ...topRepos.map(r => r.name),
    ];

    const systemPrompt = this.buildSystemPrompt({
      taskDescription: 'Analyze trending GitHub repositories to identify rising and declining technologies, adoption patterns, and emerging paradigm shifts.',
      topics: knowledgeTopics,
      responseFormat: `{
  "risingTechnologies": [
    {"name": "tech name", "signal": "description of signal", "confidence": 0.0-1.0}
  ],
  "decliningTechnologies": [
    {"name": "tech name", "signal": "description of signal", "confidence": 0.0-1.0}
  ],
  "emergingPatterns": ["pattern1", "pattern2"],
  "reasoning": "overall analysis"
}`,
    });

    const userPrompt = `Analyze the technology trends from these trending GitHub repositories:

Language distribution:
${languageStr || 'No language data available'}

Topic distribution:
${topicStr || 'No topic data available'}

Notable repos:
${repoStr || 'No notable repos'}

What technologies are rising? What's declining? What patterns do you see?`;

    try {
      const analysis = await this.llm.json<TechAnalysis>(systemPrompt, userPrompt);

      const entityIds = topRepos.map((r) => `repo:${r.name}`);

      const outputs = [
        this.createOutput(
          'tech_trend',
          {
            risingTechnologies: analysis.risingTechnologies,
            decliningTechnologies: analysis.decliningTechnologies,
            emergingPatterns: analysis.emergingPatterns,
            languageDistribution: Object.fromEntries(sortedLanguages),
            topicDistribution: Object.fromEntries(sortedTopics.slice(0, 20)),
          },
          0.55,
          analysis.reasoning,
          entityIds,
        ),
      ];

      // Save to memory
      const risingNames = analysis.risingTechnologies.slice(0, 3).map(t => t.name).join(', ');
      const decliningNames = analysis.decliningTechnologies.slice(0, 3).map(t => t.name).join(', ');
      this.memory.add({
        cycle: 0,
        type: 'observation',
        content: `Rising tech: ${risingNames || 'none detected'}. Declining: ${decliningNames || 'none detected'}. Patterns: ${analysis.emergingPatterns.slice(0, 2).join('; ') || 'none'}`,
        importance: 0.7,
      });

      await this.finalize();
      return outputs;
    } catch (err) {
      console.error(`  [TechAgent] LLM error: ${err}`);
      await this.finalize();
      return [];
    }
  }

  override filterEvents(events: WorldEvent[]): WorldEvent[] {
    return super.filterEvents(events).filter(
      (e) => e.source === 'collector:github',
    );
  }
}

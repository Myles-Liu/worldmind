import { BaseAgent } from './base-agent.js';
import type { AgentOutput, PredictionFeedback } from '../types/agent.js';
import type { WorldEvent } from '../types/event.js';

// ─── Types ──────────────────────────────────────────────────────

interface PredictionResult {
  predictions: Array<{
    statement: string;
    metric: string;
    target: string;
    currentValue: number;
    predictedValue: number;
    timeframeDays: number;
    confidence: number;
    evidence: string[];
    reasoning: string;
  }>;
}

// ─── Predict Agent ──────────────────────────────────────────────

export class PredictAgent extends BaseAgent {
  readonly name = 'predict';
  readonly description =
    'Synthesizes signals from all other agents into concrete, verifiable, time-bound predictions';

  // Historical accuracy for calibration
  private accuracyHistory: Array<{
    predicted: number;
    actual: 'correct' | 'incorrect';
  }> = [];

  /**
   * Analyze all agent outputs and generate predictions.
   */
  async analyze(events: WorldEvent[]): Promise<AgentOutput[]> {
    await this.initialize();

    // ── Get upstream agent outputs from SharedContextBus (primary) ──
    // The bus has structured outputs from Trend, Network, and Tech agents.
    // Fall back to events for backward compatibility.
    let trendOutputs: AgentOutput[] = [];
    let networkOutputs: AgentOutput[] = [];
    let techOutputs: AgentOutput[] = [];

    if (this.sharedBus) {
      trendOutputs = this.sharedBus.getOutputs('trend');
      networkOutputs = this.sharedBus.getOutputs('network');
      techOutputs = this.sharedBus.getOutputs('tech');
    }

    // Fallback: check events for backward compat
    const trendSignals = events.filter((e) => e.type === 'trend_signal');
    const networkUpdates = events.filter((e) => e.type === 'network_update');
    const techTrends = events.filter((e) => e.type === 'tech_trend');

    const hasBusData = trendOutputs.length > 0 || networkOutputs.length > 0 || techOutputs.length > 0;
    const hasEventData = trendSignals.length > 0 || networkUpdates.length > 0 || techTrends.length > 0;

    // Raw repo data for concrete predictions
    const repoEvents = events.filter(
      (e) => e.type === 'repo_trending' || e.type === 'repo_discovered' || e.type === 'new_repo_discovered',
    );

    if (!hasBusData && !hasEventData && repoEvents.length === 0) {
      console.log('    ⚠️  Predict Agent: no upstream data (bus: 0, events: 0, repos: 0)');
      await this.finalize();
      return [];
    }

    // ── Build context strings from bus (preferred) or events (fallback) ──

    let trendStr: string;
    if (trendOutputs.length > 0) {
      trendStr = trendOutputs
        .filter(o => o.outputType === 'trend_signal')
        .sort((a, b) => b.confidence - a.confidence)
        .map(o => {
          const d = o.data;
          return `- ${d['repo'] ?? 'Unknown'}: ${d['predictedGrowth'] ?? ''} growth, stars: ${d['stars'] ?? 'N/A'}, stars/day: ${d['starsPerDay'] ?? 'N/A'}, confidence: ${Math.round(o.confidence * 100)}%, key factors: ${((d['keyFactors'] as string[]) ?? []).slice(0, 3).join('; ')}`;
        }).join('\n') || 'No trend signals available';
    } else if (trendSignals.length > 0) {
      trendStr = trendSignals.map((e) => {
        const d = e.data;
        return `- ${d['repo'] ?? 'Unknown'}: ${d['predictedGrowth'] ?? ''} growth, stars/day: ${d['starsPerDay'] ?? 'N/A'}, confidence: ${e.importance}`;
      }).join('\n');
    } else {
      trendStr = 'No trend signals available';
    }

    let networkStr: string;
    if (networkOutputs.length > 0) {
      networkStr = networkOutputs
        .filter(o => o.outputType === 'network_update')
        .map(o => {
          const d = o.data;
          const clusters = (d['clusters'] as any[]) ?? [];
          const insights = (d['insights'] as string[]) ?? [];
          const keyPlayers = (d['keyPlayers'] as any[]) ?? [];
          const parts: string[] = [];
          if (clusters.length > 0) {
            parts.push(`Clusters: ${clusters.map((c: any) => `${c.theme} (${c.repos?.join(', ') ?? ''})`).join('; ')}`);
          }
          if (keyPlayers.length > 0) {
            parts.push(`Key players: ${keyPlayers.map((p: any) => `${p.repo} [${p.role}]`).join(', ')}`);
          }
          if (insights.length > 0) {
            parts.push(`Insights: ${insights.slice(0, 3).join('; ')}`);
          }
          return parts.join('\n');
        }).join('\n') || 'No network analysis available';
    } else if (networkUpdates.length > 0) {
      networkStr = networkUpdates.map((e) => {
        const d = e.data;
        const clusters = (d['clusters'] as any[]) ?? [];
        const insights = (d['insights'] as string[]) ?? [];
        return `Clusters: ${clusters.map((c: any) => `${c.theme} (${c.relationship})`).join(', ')}\nInsights: ${insights.join('; ')}`;
      }).join('\n');
    } else {
      networkStr = 'No network analysis available';
    }

    let techStr: string;
    if (techOutputs.length > 0) {
      techStr = techOutputs
        .filter(o => o.outputType === 'tech_trend')
        .map(o => {
          const d = o.data;
          const rising = (d['risingTechnologies'] as any[]) ?? [];
          const declining = (d['decliningTechnologies'] as any[]) ?? [];
          const patterns = (d['emergingPatterns'] as string[]) ?? [];
          const parts: string[] = [];
          if (rising.length > 0) {
            parts.push(`Rising: ${rising.map((t: any) => `${t.name} (${t.signal}, ${Math.round((t.confidence ?? 0) * 100)}%)`).join(', ')}`);
          }
          if (declining.length > 0) {
            parts.push(`Declining: ${declining.map((t: any) => `${t.name} (${t.signal})`).join(', ')}`);
          }
          if (patterns.length > 0) {
            parts.push(`Emerging patterns: ${patterns.slice(0, 3).join('; ')}`);
          }
          return parts.join('\n');
        }).join('\n') || 'No tech trend analysis available';
    } else if (techTrends.length > 0) {
      techStr = techTrends.map((e) => {
        const d = e.data;
        const rising = (d['risingTechnologies'] as any[]) ?? [];
        const declining = (d['decliningTechnologies'] as any[]) ?? [];
        return `Rising: ${rising.map((t: any) => `${t.name} (${t.signal})`).join(', ')}\nDeclining: ${declining.map((t: any) => `${t.name} (${t.signal})`).join(', ')}`;
      }).join('\n');
    } else {
      techStr = 'No tech trend analysis available';
    }

    // Include top repo data for concrete predictions
    const topRepos = repoEvents
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 10)
      .map((e) => {
        const m = e.data['metadata'] as any;
        if (!m) return null;
        return `- ${m.fullName}: ${m.stars} stars, ${m.language ?? 'Unknown'} lang, stars/day: ${e.data['starsPerDay'] ?? 'N/A'}`;
      })
      .filter(Boolean)
      .join('\n');

    // Build knowledge context — always include calibration data
    const knowledgeTopics = [
      'prediction_calibration',  // Always load calibration data from backtests
      ...trendOutputs.map(o => (o.data['repo'] as string) ?? '').filter(Boolean),
      ...trendSignals.map(e => (e.data['repo'] as string) ?? '').filter(Boolean),
      ...repoEvents.map(e => ((e.data['metadata'] as any)?.fullName as string) ?? '').filter(Boolean),
    ];

    const systemPrompt = this.buildSystemPrompt({
      taskDescription: 'Based on the following agent analyses, make 3-5 concrete, time-bound, verifiable predictions. Each prediction must be specific (a repo or technology), time-bound (within N days), verifiable (can be checked later), and include a confidence level.',
      topics: knowledgeTopics,
      responseFormat: `{
  "predictions": [
    {
      "statement": "specific prediction statement",
      "metric": "stars|forks|ranking|adoption",
      "target": "repo or tech name",
      "currentValue": 0,
      "predictedValue": 0,
      "timeframeDays": 30,
      "confidence": 0.5,
      "evidence": ["evidence1", "evidence2"],
      "reasoning": "detailed reasoning"
    }
  ]
}`,
    });

    // User prompt: ONLY repo data. Trend/Network/Tech are in system prompt (Layer 3 briefing).
    // Don't duplicate — duplication dilutes signal and confuses the model about what's authoritative.
    const userPrompt = topRepos
      ? `Repos to predict:\n${topRepos}\n\nGenerate 3-5 specific, verifiable predictions.`
      : `Generate 3-5 specific, verifiable predictions based on the agent briefings above.`;

    try {
      const result = await this.llm.json<PredictionResult>(systemPrompt, userPrompt);

      const outputs: AgentOutput[] = [];

      for (const pred of result.predictions) {
        outputs.push(
          this.createOutput(
            'prediction_created',
            {
              statement: pred.statement,
              metric: pred.metric,
              target: pred.target,
              currentValue: pred.currentValue,
              predictedValue: pred.predictedValue,
              timeframeDays: pred.timeframeDays,
              evidence: pred.evidence,
              reasoning: pred.reasoning,
            },
            Math.min(1, Math.max(0, pred.confidence)),
            pred.reasoning,
            pred.target ? [`repo:${pred.target}`] : [],
          ),
        );
      }

      // Save predictions to memory
      const predSummary = outputs
        .slice(0, 3)
        .map(o => `"${o.data['statement']}" (conf: ${Math.round(o.confidence * 100)}%)`)
        .join('; ');
      this.memory.add({
        cycle: 0,
        type: 'prediction',
        content: `Made ${outputs.length} predictions. Top: ${predSummary}`,
        importance: 0.8,
      });

      await this.finalize();
      return outputs;
    } catch (err) {
      console.error(`  [PredictAgent] LLM error: ${err}`);
      await this.finalize();
      return [];
    }
  }

  /**
   * Second-round revision: incorporate Challenge Agent feedback.
   * This is the "cognitive emergence" step — Predict reconsiders after
   * being confronted with counter-evidence and logical flaws.
   *
   * Returns finalized predictions with adjusted values/confidence.
   */
  async revise(
    originalPredictions: AgentOutput[],
    challenges: AgentOutput[],
  ): Promise<AgentOutput[]> {
    if (challenges.length === 0) return originalPredictions;

    await this.initialize();

    // Build a prompt that shows original predictions + challenge feedback
    const debateContext = originalPredictions.map((pred, i) => {
      const ch = challenges.find(c => c.data['target'] === pred.data['target']);
      return `
Prediction #${i + 1}: ${pred.data['target']}
  Original: ${pred.data['predictedValue']} ${pred.data['metric']} in ${pred.data['timeframeDays']}d (confidence: ${Math.round(pred.confidence * 100)}%)
  Evidence: ${((pred.data['evidence'] as string[]) ?? []).join('; ')}
  ${ch ? `
  CHALLENGE (verdict: ${ch.data['verdict']}):
    Counter-evidence: ${((ch.data['counterEvidence'] as string[]) ?? []).join('; ')}
    Logical flaws: ${((ch.data['logicalFlaws'] as string[]) ?? []).join('; ')}
    Risks: ${((ch.data['risks'] as string[]) ?? []).join('; ')}
    Challenger's revised value: ${ch.data['revisedPredictedValue'] ?? 'not provided'}
    Challenger's revised confidence: ${Math.round((ch.data['revisedConfidence'] as number ?? 0) * 100)}%
    Reasoning: ${ch.reasoning}` : '  No challenge received (upheld by default)'}`;
    }).join('\n\n');

    // Round 2: minimal prompt. No briefings, no long-term memory, no knowledge.
    // The ONLY context needed is: identity + original predictions + challenges.
    const systemPrompt = `You are a prediction engine. You produce concrete, verifiable numbers. You are judged by accuracy.

Round 2: The Challenge Agent attacked your predictions. For each:
- If their counter-evidence is solid: revise your numbers. No ego.
- If their counter-evidence is weak: hold and say why.
- No splitting the difference to be diplomatic.

Respond with valid JSON only:
{
  "revisedPredictions": [
    {
      "target": "repo name",
      "originalValue": number,
      "revisedValue": number,
      "originalConfidence": 0.0-1.0,
      "revisedConfidence": 0.0-1.0,
      "timeframeDays": number,
      "accepted_challenges": ["points you accepted"],
      "rejected_challenges": ["points you rejected and why"],
      "reasoning": "final reasoning"
    }
  ]
}`;

    const userPrompt = `Evaluate each challenge:

${debateContext}`;

    try {
      const result = await this.llm.json<{
        revisedPredictions: Array<{
          target: string;
          originalValue: number;
          revisedValue: number;
          originalConfidence: number;
          revisedConfidence: number;
          timeframeDays: number;
          accepted_challenges: string[];
          rejected_challenges: string[];
          reasoning: string;
        }>;
      }>(systemPrompt, userPrompt);

      const finalOutputs: AgentOutput[] = [];

      for (const rev of result.revisedPredictions) {
        const original = originalPredictions.find(o => o.data['target'] === rev.target);
        const challenge = challenges.find(c => c.data['target'] === rev.target);

        finalOutputs.push(
          this.createOutput(
            'prediction_finalized',
            {
              target: rev.target,
              metric: original?.data['metric'] ?? 'stars',
              originalValue: rev.originalValue,
              revisedValue: rev.revisedValue,
              originalConfidence: rev.originalConfidence,
              revisedConfidence: Math.min(1, Math.max(0, rev.revisedConfidence)),
              timeframeDays: rev.timeframeDays,
              challengeVerdict: challenge?.data['verdict'] ?? 'none',
              acceptedChallenges: rev.accepted_challenges,
              rejectedChallenges: rev.rejected_challenges,
              reasoning: rev.reasoning,
              debateRounds: 2,
            },
            Math.min(1, Math.max(0, rev.revisedConfidence)),
            rev.reasoning,
            original?.relatedEntities ?? [],
          ),
        );
      }

      // Memory: record the debate outcome
      const changed = result.revisedPredictions.filter(r => r.originalValue !== r.revisedValue).length;
      const defended = result.revisedPredictions.length - changed;
      this.addMemory({
        cycle: 0,
        type: 'reflection',
        content: `Round 2 debate: revised ${changed} predictions, defended ${defended}. Accepted challenges: ${result.revisedPredictions.flatMap(r => r.accepted_challenges).slice(0, 3).join('; ')}`,
        importance: 0.85,
      });

      await this.finalize();
      return finalOutputs;
    } catch (err) {
      console.error(`  [PredictAgent] Revision LLM error: ${err}`);
      await this.finalize();
      return originalPredictions; // Fall back to originals
    }
  }

  /**
   * Reflect on past prediction outcomes.
   */
  override async reflect(feedback: PredictionFeedback[]): Promise<void> {
    for (const fb of feedback) {
      this.accuracyHistory.push({
        predicted: 0, // TODO: Look up original confidence
        actual: fb.outcome === 'correct' ? 'correct' : 'incorrect',
      });
    }
  }
}

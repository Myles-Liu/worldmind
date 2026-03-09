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

  protected override autoSummary(
    outputType: string,
    data: Record<string, unknown>,
    confidence: number,
  ): string {
    const target = data['target'] as string ?? '?';
    if (outputType === 'prediction_finalized') {
      const val = data['revisedValue'] ?? data['predictedValue'];
      return `${target}: ${val} ${data['metric'] ?? 'stars'} in ${data['timeframeDays']}d (${Math.round(confidence * 100)}%) [final]`;
    }
    const val = data['predictedValue'];
    return `${target}: ${val} ${data['metric'] ?? 'stars'} in ${data['timeframeDays']}d (${Math.round(confidence * 100)}%)`;
  }

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

    // ── Check upstream data availability ──
    // Upstream agent outputs are injected via SharedContextBus → Layer 2 briefing.
    // We do NOT re-read raw outputs here — that would duplicate context.
    // We only need to check if there's anything to predict on.
    const hasBusData = this.sharedBus
      ? (this.sharedBus.getOutputs('trend').length > 0 ||
         this.sharedBus.getOutputs('network').length > 0 ||
         this.sharedBus.getOutputs('tech').length > 0)
      : false;

    // Raw repo data for concrete predictions (user prompt only)
    const repoEvents = events.filter(
      (e) => e.type === 'repo_trending' || e.type === 'repo_discovered' || e.type === 'new_repo_discovered',
    );

    if (!hasBusData && repoEvents.length === 0) {
      console.log('    ⚠️  Predict Agent: no upstream data');
      await this.finalize();
      return [];
    }

    // Build compact repo list for user prompt
    const topRepos = repoEvents
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 10)
      .map((e) => {
        const m = e.data['metadata'] as any;
        if (!m) return null;
        return `- ${m.fullName}: ${m.stars} stars, ${m.language ?? 'Unknown'}, ${e.data['starsPerDay'] ?? '?'}/day`;
      })
      .filter(Boolean)
      .join('\n');

    // Build knowledge topics — calibration is always relevant
    const knowledgeTopics = [
      'prediction_calibration',
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

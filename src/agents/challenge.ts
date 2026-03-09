import { BaseAgent } from './base-agent.js';
import type { AgentOutput, PredictionFeedback } from '../types/agent.js';
import type { WorldEvent } from '../types/event.js';

// ─── Types ──────────────────────────────────────────────────────

interface ChallengeResult {
  challenges: Array<{
    prediction: string;
    counterEvidence: string[];
    logicalFlaws: string[];
    risks: string[];
    revisedConfidence: number;
    revisedPredictedValue?: number;
    verdict: 'upheld' | 'weakened' | 'rejected';
    reasoning: string;
  }>;
}

// ─── Challenge Agent ────────────────────────────────────────────

export class ChallengeAgent extends BaseAgent {
  readonly name = 'challenge';
  readonly description =
    'Critically examines predictions, finds counter-evidence, and identifies logical flaws and biases';

  protected override autoSummary(
    _outputType: string,
    data: Record<string, unknown>,
    confidence: number,
  ): string {
    const target = data['target'] as string ?? '?';
    const verdict = data['verdict'] as string ?? '?';
    return `${target}: ${verdict} (${Math.round(confidence * 100)}%)`;
  }

  // Track which prediction types are most error-prone
  private errorPatterns: Map<string, { total: number; errors: number }> = new Map();

  /**
   * Challenge predictions from the Predict Agent.
   */
  async analyze(events: WorldEvent[]): Promise<AgentOutput[]> {
    await this.initialize();

    // ── Get predictions from SharedContextBus (primary) or events (fallback) ──
    // The Predict Agent publishes to the bus; events array only contains raw
    // perception data and won't have prediction_created entries.
    let predictOutputs: AgentOutput[] = [];
    if (this.sharedBus) {
      predictOutputs = this.sharedBus.getOutputs('predict')
        .filter(o => o.outputType === 'prediction_created');
    }

    // Fallback: also check events for backward compatibility
    const predictionEvents = events.filter((e) => e.type === 'prediction_created');

    // If neither source has predictions, nothing to challenge
    if (predictOutputs.length === 0 && predictionEvents.length === 0) {
      console.log('    ⚠️  Challenge Agent: no predictions found (bus: 0, events: 0)');
      await this.finalize();
      return [];
    }

    const outputs: AgentOutput[] = [];

    // Build predictions text from bus outputs (preferred) or events (fallback)
    let predictionsText: string;
    let knowledgeTopics: string[];

    if (predictOutputs.length > 0) {
      // Compact format: numbers and key claims only. Challenge doesn't need full evidence.
      predictionsText = predictOutputs
        .map((o, i) => {
          const d = o.data;
          const evidence = (d['evidence'] as string[]) ?? [];
          // Only pass top 3 evidence points, truncated
          const topEvidence = evidence.slice(0, 3).map(e => e.slice(0, 100));
          return `#${i + 1} ${d['target'] ?? '?'}: ${d['currentValue'] ?? '?'} → ${d['predictedValue'] ?? '?'} ${d['metric'] ?? 'stars'} in ${d['timeframeDays'] ?? '?'}d (conf ${Math.round(o.confidence * 100)}%). Key evidence: ${topEvidence.join('; ') || 'none'}`;
        })
        .join('\n');

      knowledgeTopics = predictOutputs
        .map(o => (o.data['target'] as string) ?? '')
        .filter(Boolean);
    } else {
      // Fallback to events — same compact format
      predictionsText = predictionEvents
        .map((e, i) => {
          const d = e.data;
          const evidence = (d['evidence'] as string[]) ?? [];
          const topEvidence = evidence.slice(0, 3).map(ev => ev.slice(0, 100));
          return `#${i + 1} ${d['target'] ?? '?'}: ${d['currentValue'] ?? '?'} → ${d['predictedValue'] ?? '?'} ${d['metric'] ?? 'stars'} in ${d['timeframeDays'] ?? '?'}d (conf ${Math.round(e.importance * 100)}%). Key evidence: ${topEvidence.join('; ') || 'none'}`;
        })
        .join('\n');

      knowledgeTopics = predictionEvents
        .map(e => (e.data['target'] as string) ?? '')
        .filter(Boolean);
    }

    // Total prediction count for downstream use
    const totalPredictions = predictOutputs.length || predictionEvents.length;

    const systemPrompt = this.buildSystemPrompt({
      taskDescription: 'Stress-test the following predictions. For each, find weaknesses, counter-evidence, and logical flaws. Assign a revised confidence level and verdict.',
      topics: knowledgeTopics,
      additionalContext: `Rules:
- No floor on confidence reduction. If the prediction is garbage, slash it to 5%.
- REJECTED is normal. Use it when evidence is weak.
- Always provide your own counter-estimate (revisedPredictedValue).
- Attack the numbers, not the vibes.

Common biases IN THE PREDICTIONS you're reviewing:
- Hype inflation: confusing initial spike with sustained growth
- Celebrity bias: "famous author = guaranteed success"
- Category error: "AI is hot, therefore any AI repo will explode"
- Base rate neglect: most entities never reach significant adoption, period`,
      responseFormat: `{
  "challenges": [
    {
      "prediction": "the prediction being challenged",
      "counterEvidence": ["counter1", "counter2"],
      "logicalFlaws": ["flaw1"],
      "risks": ["risk1"],
      "revisedConfidence": 0.0-1.0,
      "revisedPredictedValue": number_or_null,
      "verdict": "upheld|weakened|rejected",
      "reasoning": "explanation"
    }
  ]
}

IMPORTANT: When you weaken or reject a prediction, you MUST provide a "revisedPredictedValue" — your own estimate of the correct value. Don't just say "this is wrong", say what you think is right.`,
    });

    const userPrompt = `Critically analyze and stress-test these predictions:

${predictionsText}

For each prediction, find weaknesses, counter-evidence, and logical flaws. Assign a revised confidence level.`;

    try {
      const result = await this.llm.json<ChallengeResult>(systemPrompt, userPrompt);

      // No artificial floors on confidence. Let the Challenge Agent be as harsh as the evidence warrants.

      for (let i = 0; i < result.challenges.length; i++) {
        const challenge = result.challenges[i];
        if (!challenge) continue;
        // Get entity IDs from bus outputs or events
        const originalOutput = predictOutputs[i];
        const originalEvent = predictionEvents[i];
        const entityIds = originalOutput?.relatedEntities ?? (originalEvent ? originalEvent.entities : []);

        // Carry forward the target repo name so downstream can match challenge → prediction
        const target = originalOutput?.data['target']
          ?? originalEvent?.data['target']
          ?? '';

        outputs.push(
          this.createOutput(
            'prediction_challenged',
            {
              target,
              originalPrediction: challenge.prediction,
              counterEvidence: challenge.counterEvidence,
              logicalFlaws: challenge.logicalFlaws,
              risks: challenge.risks,
              revisedConfidence: Math.min(1, Math.max(0, challenge.revisedConfidence)),
              revisedPredictedValue: challenge.revisedPredictedValue ?? null,
              verdict: challenge.verdict,
            },
            Math.min(1, Math.max(0, challenge.revisedConfidence)),
            challenge.reasoning,
            entityIds,
            `${target}: ${challenge.verdict}, revised to ${challenge.revisedPredictedValue ?? 'N/A'} (${Math.round(challenge.revisedConfidence * 100)}%)`,
          ),
        );
      }

      // Save to memory
      const verdictCounts = { upheld: 0, weakened: 0, rejected: 0 };
      for (const c of result.challenges) {
        if (c.verdict in verdictCounts) {
          verdictCounts[c.verdict as keyof typeof verdictCounts]++;
        }
      }
      this.memory.add({
        cycle: 0,
        type: 'observation',
        content: `Challenged ${totalPredictions} predictions. Verdicts: ${verdictCounts.upheld} upheld, ${verdictCounts.weakened} weakened, ${verdictCounts.rejected} rejected. Common flaws: ${result.challenges.flatMap(c => c.logicalFlaws).slice(0, 3).join('; ') || 'none'}`,
        importance: 0.7,
      });

      await this.finalize();
      return outputs;
    } catch (err) {
      console.error(`  [ChallengeAgent] LLM error: ${err}`);
      await this.finalize();
      return [];
    }
  }

  /**
   * Learn from prediction outcomes which types of predictions fail.
   */
  override async reflect(feedback: PredictionFeedback[]): Promise<void> {
    for (const fb of feedback) {
      const category = 'general'; // TODO: Look up prediction category
      const existing = this.errorPatterns.get(category) ?? { total: 0, errors: 0 };
      existing.total++;
      if (fb.outcome === 'incorrect') existing.errors++;
      this.errorPatterns.set(category, existing);
    }
  }
}

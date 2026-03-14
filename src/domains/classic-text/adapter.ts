/**
 * Classic Text Domain Adapter
 *
 * Interprets ancient wisdom through dramatization and multi-agent simulation.
 * Analyzes how classical principles apply to modern scenarios.
 */

import type {
  DomainAdapter,
  DomainConfig,
  PredictionRequest,
  PredictionOutcome,
} from '../types.js';
import type { WorldEvent } from '../../types/event.js';
import type { Agent, AgentOutput } from '../../types/agent.js';
import { BaseAgent } from '../../agents/base-agent.js';
import { TrendAgent } from '../../agents/trend.js';
import { PredictAgent } from '../../agents/predict.js';
import { ChallengeAgent } from '../../agents/challenge.js';
import { ScriptGenerator, createScriptGenerator } from './script-generator.js';
import { OasisDramatizer, createOasisDramatizer, type OasisDramatizationConfig } from './oasis-dramatizer.js';
import { CustomLLMClient } from '../../llm/custom-llm-client.js';
type LLMClient = any;

// ─── Domain Config ──────────────────────────────────────────────

export const ClassicTextDomainConfig: DomainConfig = {
  name: 'classic-text',
  description:
    'Dramatization of ancient wisdom — interprets classical Chinese texts through modern scenarios using multi-agent simulation',
  entityTypes: ['text', 'principle', 'character', 'scenario', 'script'],
  metrics: ['principle_clarity', 'scenario_relevance', 'character_authenticity', 'dialogue_quality', 'insight_depth'],
  temporalRules: [
    'Ancient principles remain valid across centuries when properly contextualized.',
    'A principle demonstrated successfully in one domain often transfers to others.',
    'Character development and dialogue depth increase with number of simulation turns.',
    'Audience insight grows with each act as the principle becomes more tangible.',
    'Multi-perspective narratives (narrator + observer) provide deeper understanding.',
    'Conflict and resolution cycles (3+ acts) create stronger principle internalization.',
  ],
  agentContext: {
    trend: [
      'Domain: Ancient wisdom dramatization.',
      'Key metrics: principle clarity, scenario relevance, dialogue authenticity.',
      'Track how effectively ancient principles manifest in modern contexts.',
      'Identify which characters/roles drive the principle forward vs. challenge it.',
    ].join(' '),
    predict: [
      'Domain: Classical text interpretation and application.',
      'Base rate: Most ancient principles have multiple valid interpretations.',
      'Predict: How well a principle transfers to different scenario types (warfare, business, interpersonal).',
      'Metrics: principle_clarity, scenario_relevance, character_authenticity, dialogue_quality.',
    ].join(' '),
    challenge: [
      'Domain: Classical text dramatization.',
      'Base rate: Dramatizations may oversimplify or romanticize ancient principles.',
      'LLM agents may struggle with nuanced philosophical concepts.',
      'Check: Is the interpretation historically accurate or just plausible-sounding?',
      'Verify: Does the scenario genuinely test the principle or just illustrate it?',
    ].join(' '),
  },
  initialKnowledge: [
    {
      topic: 'ancient_principles',
      content:
        '孙子兵法 emphasizes that winning is determined before battle begins through superior positioning, intelligence, and preparation. The principle transfers to business strategy, competitive negotiation, and organizational leadership.',
      source: 'system',
      relevance: 0.95,
    },
    {
      topic: 'dramatization_effectiveness',
      content:
        'Dramatization is most effective when it includes opposing perspectives (protagonist vs. antagonist) and a neutral narrator. Multi-agent scenarios demonstrate principles more convincingly than monologues.',
      source: 'system',
      relevance: 0.9,
    },
    {
      topic: 'scenario_transfer',
      content:
        'Principles proven in warfare scenarios often transfer to business competition, but the transfer is not automatic. Social/interpersonal scenarios require adaptation of competitive elements to collaborative frameworks.',
      source: 'system',
      relevance: 0.85,
    },
  ],
};

// ─── Adapter ────────────────────────────────────────────────────

export class ClassicTextDomainAdapter implements DomainAdapter {
  readonly config = ClassicTextDomainConfig;

  private agents: Agent[];
  private scriptGenerator: ScriptGenerator;
  private dramatizer: OasisDramatizer | null = null;
  private dramatizationConfig: OasisDramatizationConfig;

  constructor(options?: { llmClient?: LLMClient; dramatizationConfig?: OasisDramatizationConfig }) {
    // Initialize LLM client
    const llmClient = options?.llmClient ?? new CustomLLMClient();

    // Initialize agents
    this.agents = [new TrendAgent(), new PredictAgent(), new ChallengeAgent()];

    // Inject domain-specific context
    const ctx = ClassicTextDomainConfig.agentContext ?? {};
    for (const agent of this.agents) {
      if (agent instanceof BaseAgent && ctx[agent.name]) {
        agent.setDomainContext(ctx[agent.name]!);
      }
    }

    // Initialize script generator
    this.scriptGenerator = createScriptGenerator(llmClient);

    // Initialize dramatization config
    this.dramatizationConfig = options?.dramatizationConfig ?? {
      workDir: './dramatization_output',
      maxTurns: 10,
      allowImprov: true,
      llm: {
        apiKey: process.env['WORLDMIND_LLM_API_KEY'] ?? '',
        baseUrl: process.env['WORLDMIND_LLM_BASE_URL'],
        model: process.env['WORLDMIND_LLM_MODEL'] ?? 'gpt-4',
      },
    };
  }

  /**
   * Collect events by dramatizing a classical text.
   * For this domain, "collecting" means generating and simulating a script.
   */
  async collect(): Promise<WorldEvent[]> {
    // For now, return empty events as this domain works differently
    // In a real scenario, you would:
    // 1. Select a classical text
    // 2. Generate a script
    // 3. Run dramatization
    // 4. Convert output to WorldEvents

    console.log(`\n  📖 Classic Text Domain Collection`);
    console.log(`     This domain requires active script generation rather than passive data collection.`);
    console.log(`     Use dramatizeText() method directly for dramatization.`);

    return [];
  }

  /**
   * Dramatize an ancient text with a specific principle and scenario.
   * This is the main entry point for this domain.
   */
  async dramatizeText(request: any): Promise<{ script: any; output: any }> {
    console.log(`\n  📜 Dramatizing classical text...`);

    // Generate script from classical text
    const script = await this.scriptGenerator.generate(request);

    console.log(`     Script generated: "${script.principle}"`);
    console.log(`     Acts: ${script.acts.length}, Characters: ${script.characters.length}`);

    // Create and run dramatizer
    this.dramatizer = createOasisDramatizer(this.dramatizationConfig);
    const dramatizationOutput = await this.dramatizer.dramatize(script);

    console.log(`\n${dramatizationOutput.summary}`);

    return {
      script,
      output: dramatizationOutput,
    };
  }

  /**
   * Get the underlying script generator for advanced usage.
   */
  getScriptGenerator(): ScriptGenerator {
    return this.scriptGenerator;
  }

  /**
   * Get the dramatizer instance (if initialized).
   */
  getDramatizer(): OasisDramatizer | null {
    return this.dramatizer;
  }

  getAgents(): Agent[] {
    return this.agents;
  }

  verify(prediction: PredictionRequest, actual: Record<string, unknown>): PredictionOutcome {
    // For classic text domain, verification focuses on principle clarity
    const actualValue = (actual[prediction.metric] as number) ?? 0;
    const error = actualValue > 0 ? Math.abs(1 - actualValue) : 0;

    return {
      correct: error <= 0.3, // Allow 30% variance
      error,
      actualValue,
    };
  }

  score(outputs: AgentOutput[]): number {
    if (outputs.length === 0) return 0;
    return outputs.reduce((sum, o) => sum + o.confidence, 0) / outputs.length;
  }
}

// ─── Factory ────────────────────────────────────────────────────

export function createClassicTextAdapter(options?: {
  llmClient?: LLMClient;
  dramatizationConfig?: OasisDramatizationConfig;
}): ClassicTextDomainAdapter {
  return new ClassicTextDomainAdapter(options);
}

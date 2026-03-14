/**
 * Script Generator
 * 
 * Generates dramatized scripts from ancient Chinese texts
 * using LLM to interpret principles and create modern scenarios.
 */

import { LLMClient } from '../../llm/client.js';
import type {
  Script,
  ScriptAct,
  Dialogue,
  Character,
  ScriptRequest,
  SceneType,
  RoleType,
} from './types.js';

// ─── Default Characters ─────────────────────────────────────────

const DEFAULT_CHARACTERS: Record<RoleType, Partial<Character>> = {
  protagonist: {
    name: '策略者',
    personality: '睿智、深思熟虑、执行力强',
    background: '熟悉古籍智慧的现代企业家',
  },
  antagonist: {
    name: '对手',
    personality: '竞争激烈、直接、意志坚定',
    background: '传统思维的竞争对手',
  },
  advisor: {
    name: '谋士',
    personality: '博学、善于分析、深谋远虑',
    background: '古籍研究者与现代顾问',
  },
  narrator: {
    name: 'narrator',
    personality: '客观、深邃、智慧',
    background: '古籍原理的诠释者',
  },
  observer: {
    name: '旁观者',
    personality: '中立、观察力敏锐、反思深刻',
    background: '见证者与评论者',
  },
};

// ─── Script Generator ───────────────────────────────────────────

export class ScriptGenerator {
  private llm: LLMClient;

  constructor(llmClient?: LLMClient) {
    this.llm = llmClient ?? new LLMClient();
  }

  /**
   * Generate a dramatized script from an ancient text passage.
   */
  async generate(request: ScriptRequest): Promise<Script> {
    // Extract the principle from the source text
    const principle = await this.extractPrinciple(request);

    // Generate modern interpretation
    const interpretation = await this.generateInterpretation(request, principle);

    // Generate characters based on scene type
    const characters = this.createCharacters(request, principle);

    // Generate the dramatized acts
    const acts = await this.generateActs(request, principle, characters);

    // Generate epilogue
    const epilogue = await this.generateEpilogue(principle, acts);

    const script: Script = {
      id: `script_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      sourceText: request.sourceText,
      sourceBook: request.sourceBook,
      sourceChapter: request.sourceChapter ?? 'unknown',
      principle,
      interpretation,
      sceneType: request.sceneType,
      sceneDescription: request.customSceneDescription ?? this.getSceneDescription(request.sceneType),
      characters,
      acts,
      epilogue,
      createdAt: new Date().toISOString(),
    };

    return script;
  }

  // ─── Private Methods ────────────────────────────────────────

  /**
   * Extract the core principle from the ancient text using LLM.
   */
  private async extractPrinciple(request: ScriptRequest): Promise<string> {
    const systemPrompt = `You are an expert in classical Chinese texts and philosophy.
Extract the core principle or wisdom from the given ancient text passage.
Provide a concise, actionable principle in both Chinese and English.
Format: "原理: [Chinese principle]. Principle: [English principle]."`;

    const userMessage = `Ancient text (from ${request.sourceBook}):

"${request.sourceText}"

Extract the core principle demonstrated here.`;

    const response = await this.llm.complete(systemPrompt, userMessage, {
      temperature: 0.3,
      maxTokens: 300,
    });

    return response;
  }

  /**
   * Generate a modern interpretation of the principle.
   */
  private async generateInterpretation(request: ScriptRequest, principle: string): Promise<string> {
    const systemPrompt = `You are a business strategist and classical scholar.
Given an ancient principle, provide a detailed modern interpretation showing how it applies to contemporary scenarios.
Focus on practical, actionable insights.`;

    const sceneContext = this.getSceneDescription(request.sceneType);

    const userMessage = `Principle: ${principle}

Original text: "${request.sourceText}"

Modern scenario type: ${request.sceneType}
${request.customSceneDescription ? `Custom context: ${request.customSceneDescription}` : ''}

Provide a detailed interpretation of how this principle applies in today's ${request.sceneType} context.
Keep it concise but insightful (2-3 paragraphs).`;

    const response = await this.llm.complete(systemPrompt, userMessage, {
      temperature: 0.5,
      maxTokens: 500,
    });

    return response;
  }

  /**
   * Create character objects for the script.
   */
  private createCharacters(request: ScriptRequest, principle: string): Character[] {
    const overrides: Record<RoleType, string> = (request.characterNames as Record<RoleType, string>) ?? {};
    const roles: RoleType[] = ['protagonist', 'antagonist', 'advisor', 'narrator', 'observer'];

    return roles.map((role, idx) => {
      const base = DEFAULT_CHARACTERS[role] ?? {};
      const name = overrides[role] ?? base.name ?? role;

      return {
        id: `char_${role}_${idx}`,
        name,
        role,
        personality: base.personality ?? '',
        goals:
          role === 'protagonist'
            ? ['Apply ancient wisdom to achieve success', 'Understand the principle deeply']
            : role === 'antagonist'
              ? ['Challenge the strategy', 'Prove the principle wrong']
              : role === 'advisor'
                ? ['Guide and advise', 'Explain the principle']
                : [],
        background: base.background ?? `Character with role: ${role}`,
      };
    });
  }

  /**
   * Generate the dramatized acts using LLM.
   */
  private async generateActs(
    request: ScriptRequest,
    principle: string,
    characters: Character[],
  ): Promise<ScriptAct[]> {
    const systemPrompt = `You are a brilliant screenwriter specializing in dramatizing ancient wisdom.
Create a dramatic scene with dialogue that brings a classical principle to life in a modern context.

Return ONLY valid JSON (no markdown, no extra text). Example structure:
{
  "acts": [
    {
      "actNumber": 1,
      "title": "Scene title in Chinese",
      "description": "What happens in this act",
      "principleApplied": "How the principle is demonstrated",
      "dialogues": [
        {"speaker": "character_id", "content": "dialogue text", "isThought": false, "emotion": "emotion"}
      ]
    }
  ]
}`;

    const characterList = characters
      .map((c) => `- ${c.name} (${c.role}): ${c.personality}`)
      .join('\n');

    const userMessage = `Create a 3-act dramatization of this principle:

Principle: ${principle}
Original text: "${request.sourceText}"
Modern scenario: ${request.sceneType}
${request.customSceneDescription ? `Custom context: ${request.customSceneDescription}` : ''}

Characters:
${characterList}

Generate realistic dialogue that demonstrates how the ancient principle applies to the modern scenario.
Each act should build on the last, showing the principle's practical impact.
Include internal thoughts where appropriate.

Return ONLY the JSON structure with acts array.`;

    const response = await this.llm.json<{ acts: ScriptAct[] }>(systemPrompt, userMessage, {
      temperature: 0.7,
      maxTokens: 2000,
    });

    return response.acts;
  }

  /**
   * Generate the epilogue narration.
   */
  private async generateEpilogue(principle: string, acts: ScriptAct[]): Promise<string> {
    const systemPrompt = `You are a wise narrator who concludes a dramatized scene.
Write a final reflection that ties together the dramatization and the original principle.
Make it insightful, memorable, and applicable to the reader's life.`;

    const actSummary = acts.map((a) => `- ${a.title}: ${a.description}`).join('\n');

    const userMessage = `Based on this principle:
${principle}

The dramatization included:
${actSummary}

Write a narrator's epilogue (2-3 paragraphs) that reflects on what was demonstrated,
how the ancient wisdom proved itself in the modern scenario, and what the audience should remember.`;

    const response = await this.llm.complete(systemPrompt, userMessage, {
      temperature: 0.6,
      maxTokens: 400,
    });

    return response;
  }

  /**
   * Get default scene description based on type.
   */
  private getSceneDescription(sceneType: SceneType): string {
    const descriptions: Record<SceneType, string> = {
      warfare: 'A competitive business battle where strategy and tactics determine victory.',
      business: 'A negotiation or strategic business decision requiring wisdom and foresight.',
      interpersonal: 'A personal relationship or social situation testing character and principles.',
      workplace: 'A modern office scenario with organizational politics and team dynamics.',
      custom: 'A custom scenario combining elements of strategy, conflict, and resolution.',
    };
    return descriptions[sceneType] ?? descriptions.custom;
  }
}

// ─── Exports ────────────────────────────────────────────────────

export function createScriptGenerator(llmClient?: LLMClient): ScriptGenerator {
  return new ScriptGenerator(llmClient);
}

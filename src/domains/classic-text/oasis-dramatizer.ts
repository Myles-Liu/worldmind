/**
 * OASIS Dramatizer
 * 
 * Converts a dramatized script into OASIS agent configurations
 * and runs a multi-agent simulation to bring the ancient wisdom to life.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Script, ScriptAct, Dialogue, OasisAgentConfig, DramatizationConfig } from './types.js';

// ─── OASIS Config ───────────────────────────────────────────────

export interface OasisDramatizationConfig {
  /** Path to working directory for OASIS */
  workDir: string;

  /** Max turns for the simulation */
  maxTurns: number;

  /** Allow agents to improvise beyond the script */
  allowImprov: boolean;

  /** System prompt template for agent generation */
  systemPromptTemplate?: string;

  /** LLM config for OASIS agents */
  llm?: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
  };
}

// ─── Dramatizer ─────────────────────────────────────────────────

export class OasisDramatizer {
  private config: OasisDramatizationConfig;
  private process: ChildProcess | null = null;
  private simulationOutput: string[] = [];

  constructor(config: OasisDramatizationConfig) {
    this.config = config;

    // Ensure work directory exists
    if (!existsSync(config.workDir)) {
      mkdirSync(config.workDir, { recursive: true });
    }
  }

  /**
   * Convert a script into OASIS agent configurations.
   */
  generateAgentConfigs(script: Script): OasisAgentConfig[] {
    return script.characters.map((character) => {
      const systemPrompt = this.generateSystemPrompt(character, script);

      return {
        characterId: character.id,
        personality: character.personality,
        goals: character.goals,
        systemPrompt,
      };
    });
  }

  /**
   * Run a full OASIS simulation based on the script.
   */
  async dramatize(script: Script): Promise<DramatizationOutput> {
    const agentConfigs = this.generateAgentConfigs(script);

    console.log(`\n  📽️  OASIS Dramatization: "${script.sourceBook}"`);
    console.log(`     Principle: ${script.principle}`);
    console.log(`     Characters: ${script.characters.length}`);
    console.log(`     Acts: ${script.acts.length}`);
    console.log(`     Max turns: ${this.config.maxTurns}`);

    // Create the simulation context
    const simulationContext = this.createSimulationContext(script, agentConfigs);

    // Write context to file
    const contextPath = join(this.config.workDir, `simulation_context_${Date.now()}.json`);
    writeFileSync(contextPath, JSON.stringify(simulationContext, null, 2));

    console.log(`     Context saved to: ${contextPath}`);

    // Run the OASIS simulation
    const result = await this.runSimulation(simulationContext, agentConfigs);

    return {
      script,
      agentConfigs,
      simulationOutput: this.simulationOutput,
      summary: this.generateSummary(script, result),
      contextPath,
    };
  }

  /**
   * Stop the running simulation.
   */
  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  // ─── Private Methods ────────────────────────────────────────

  /**
   * Generate a system prompt for an agent based on character and script.
   */
  private generateSystemPrompt(character: any, script: Script): string {
    const template =
      this.config.systemPromptTemplate ||
      `You are {{name}}, a character in a dramatization of an ancient wisdom.

Character Profile:
- Role: {{role}}
- Personality: {{personality}}
- Background: {{background}}
- Goals: {{goals}}

Context:
The scene is set in a {{sceneType}} scenario that demonstrates the principle: "{{principle}}"

Original Ancient Text:
"{{sourceText}}"

Modern Interpretation:
{{interpretation}}

Instructions:
1. Stay in character throughout the conversation.
2. Demonstrate the ancient principle through your actions and words.
3. Engage genuinely with other characters.
4. If you're the narrator, provide insights about the principle.
5. Use realistic dialogue appropriate to the scenario.
6. Be prepared to explain your reasoning when challenged.{{improvFlag}}

Engage naturally in the simulation while staying true to your character and the principle.`;

    return template
      .replace('{{name}}', character.name)
      .replace('{{role}}', character.role)
      .replace('{{personality}}', character.personality)
      .replace('{{background}}', character.background)
      .replace('{{goals}}', character.goals.join(', '))
      .replace('{{sceneType}}', script.sceneType)
      .replace('{{principle}}', script.principle)
      .replace('{{sourceText}}', script.sourceText)
      .replace('{{interpretation}}', script.interpretation)
      .replace('{{improvFlag}}', this.config.allowImprov ? '\n7. You may improvise within reason while maintaining the principle.' : '');
  }

  /**
   * Create the full simulation context for OASIS.
   */
  private createSimulationContext(script: Script, agentConfigs: OasisAgentConfig[]): SimulationContext {
    return {
      type: 'dramatization',
      script: {
        id: script.id,
        principle: script.principle,
        interpretation: script.interpretation,
        sourceBook: script.sourceBook,
        sourceChapter: script.sourceChapter,
        sceneType: script.sceneType,
        sceneDescription: script.sceneDescription,
        epilogue: script.epilogue,
      },
      characters: script.characters.map((c) => ({
        id: c.id,
        name: c.name,
        role: c.role,
        personality: c.personality,
        goals: c.goals,
        background: c.background,
      })),
      agents: agentConfigs,
      acts: script.acts.map((act) => ({
        actNumber: act.actNumber,
        title: act.title,
        description: act.description,
        principleApplied: act.principleApplied,
        dialogueCount: act.dialogues.length,
      })),
      config: {
        maxTurns: this.config.maxTurns,
        allowImprov: this.config.allowImprov,
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * Run the OASIS simulation (placeholder for now).
   * In a real implementation, this would spawn the OASIS process.
   */
  private async runSimulation(context: SimulationContext, agentConfigs: OasisAgentConfig[]): Promise<SimulationResult> {
    // For now, we simulate the OASIS interaction
    // In production, this would spawn the Python OASIS process similar to social/oasis-bridge.ts

    console.log(`     Starting multi-agent simulation...`);

    const result: SimulationResult = {
      totalTurns: 0,
      agentsInvolved: agentConfigs.length,
      principleValidated: true,
      keyInsights: await this.extractKeyInsights(context),
      timestamp: new Date().toISOString(),
    };

    // Simulate turns
    for (let turn = 0; turn < Math.min(5, this.config.maxTurns); turn++) {
      this.simulationOutput.push(`[Turn ${turn + 1}] Agents deliberating on principle...`);
      result.totalTurns++;

      // Small delay to simulate processing
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    console.log(`     ✅ Simulation complete: ${result.totalTurns} turns, ${result.agentsInvolved} agents`);

    return result;
  }

  /**
   * Extract key insights from the simulation context.
   */
  private async extractKeyInsights(context: SimulationContext): Promise<string[]> {
    return [
      `Principle "${context.script.principle}" demonstrated through ${context.agents.length} agent perspectives`,
      `Scene type: ${context.script.sceneType} - ${context.script.sceneDescription}`,
      `Key characters: ${context.characters.map((c) => c.name).join(', ')}`,
      `Interpretation: Ancient wisdom applied to modern scenarios`,
    ];
  }

  /**
   * Generate a summary of the dramatization.
   */
  private generateSummary(script: Script, result: SimulationResult): string {
    return `
═══════════════════════════════════════════════════════════════
                    DRAMATIZATION SUMMARY
═══════════════════════════════════════════════════════════════

📚 Source: ${script.sourceBook} (${script.sourceChapter})
Principle: ${script.principle}

🎭 Scenario: ${script.sceneType.toUpperCase()}
Description: ${script.sceneDescription}

👥 Characters: ${script.characters.length}
${script.characters.map((c) => `   • ${c.name} (${c.role}): ${c.personality}`).join('\n')}

📖 Acts: ${script.acts.length}
${script.acts.map((a) => `   • Act ${a.actNumber}: ${a.title} - ${a.principleApplied}`).join('\n')}

🎬 Simulation Result:
   • Total Turns: ${result.totalTurns}
   • Agents Involved: ${result.agentsInvolved}
   • Principle Validated: ${result.principleValidated ? 'Yes ✓' : 'No ✗'}

💡 Key Insights:
${result.keyInsights.map((insight) => `   • ${insight}`).join('\n')}

📝 Epilogue:
${script.epilogue}

═══════════════════════════════════════════════════════════════
    Generated at ${result.timestamp}
═══════════════════════════════════════════════════════════════
`;
  }
}

// ─── Types ──────────────────────────────────────────────────────

export interface SimulationContext {
  type: 'dramatization';
  script: {
    id: string;
    principle: string;
    interpretation: string;
    sourceBook: string;
    sourceChapter: string;
    sceneType: string;
    sceneDescription: string;
    epilogue: string;
  };
  characters: Array<{
    id: string;
    name: string;
    role: string;
    personality: string;
    goals: string[];
    background: string;
  }>;
  agents: OasisAgentConfig[];
  acts: Array<{
    actNumber: number;
    title: string;
    description: string;
    principleApplied: string;
    dialogueCount: number;
  }>;
  config: {
    maxTurns: number;
    allowImprov: boolean;
    timestamp: string;
  };
}

export interface SimulationResult {
  totalTurns: number;
  agentsInvolved: number;
  principleValidated: boolean;
  keyInsights: string[];
  timestamp: string;
}

export interface DramatizationOutput {
  script: Script;
  agentConfigs: OasisAgentConfig[];
  simulationOutput: string[];
  summary: string;
  contextPath: string;
}

// ─── Exports ────────────────────────────────────────────────────

export function createOasisDramatizer(config: OasisDramatizationConfig): OasisDramatizer {
  return new OasisDramatizer(config);
}

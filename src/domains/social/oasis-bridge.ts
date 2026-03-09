/**
 * OASIS Bridge — TypeScript ↔ Python OASIS integration
 *
 * Spawns an OASIS simulation as a Python subprocess,
 * communicates via JSON-over-stdin/stdout protocol.
 *
 * WorldMind agents consume OASIS simulation output (agent actions, posts,
 * social dynamics) as WorldEvents for analysis and prediction.
 */

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createEvent, type WorldEvent } from '../../types/event.js';

// ─── Types ──────────────────────────────────────────────────────

export interface OasisConfig {
  /** Platform to simulate: 'twitter' | 'reddit' */
  platform: 'twitter' | 'reddit';

  /** Path to agent profiles (CSV for twitter, JSON for reddit) */
  profilePath: string;

  /** Path for the simulation SQLite database */
  dbPath?: string;

  /** Number of simulation rounds */
  rounds?: number;

  /** Minutes per round (default 30 → 1 round = 30 simulated minutes) */
  minutesPerRound?: number;

  /** Max concurrent LLM requests */
  semaphore?: number;

  /** LLM config (passed to OASIS via env vars) */
  llm?: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
  };
}

export interface SimulationAction {
  round: number;
  agentId: number;
  agentName: string;
  actionType: string;
  content?: string;
  targetId?: number;
  timestamp: string;
}

export interface SimulationState {
  round: number;
  totalRounds: number;
  totalActions: number;
  running: boolean;
  actions: SimulationAction[];
}

// ─── Bridge ─────────────────────────────────────────────────────

export class OasisBridge {
  private config: OasisConfig;
  private process: ChildProcess | null = null;
  private state: SimulationState;
  private bridgeScript: string;

  constructor(config: OasisConfig) {
    this.config = config;
    this.state = {
      round: 0,
      totalRounds: config.rounds ?? 10,
      totalActions: 0,
      running: false,
      actions: [],
    };

    // Bridge script lives next to this file
    const here = new URL('.', import.meta.url).pathname;
    this.bridgeScript = join(here, 'oasis_runner.py');
  }

  /**
   * Start the OASIS simulation subprocess.
   */
  async start(): Promise<void> {
    if (this.state.running) throw new Error('Simulation already running');

    // Ensure bridge script exists
    if (!existsSync(this.bridgeScript)) {
      throw new Error(`OASIS bridge script not found: ${this.bridgeScript}`);
    }

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      OASIS_PLATFORM: this.config.platform,
      OASIS_PROFILE_PATH: this.config.profilePath,
      OASIS_DB_PATH: this.config.dbPath ?? './oasis_sim.db',
      OASIS_ROUNDS: String(this.config.rounds ?? 10),
      OASIS_MINUTES_PER_ROUND: String(this.config.minutesPerRound ?? 30),
      OASIS_SEMAPHORE: String(this.config.semaphore ?? 10),
    };

    if (this.config.llm) {
      env['OPENAI_API_KEY'] = this.config.llm.apiKey;
      if (this.config.llm.baseUrl) env['OPENAI_API_BASE_URL'] = this.config.llm.baseUrl;
      if (this.config.llm.model) env['OASIS_LLM_MODEL'] = this.config.llm.model;
    }

    this.process = spawn('python3', [this.bridgeScript], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.state.running = true;

    // Read stdout line-by-line for JSON events
    let buffer = '';
    this.process.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop()!; // keep incomplete line
      for (const line of lines) {
        if (line.trim()) this.handleEvent(line.trim());
      }
    });

    this.process.stderr!.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.error(`  [OASIS] ${msg}`);
    });

    this.process.on('exit', (code) => {
      this.state.running = false;
      console.log(`  [OASIS] Process exited with code ${code}`);
    });
  }

  /**
   * Wait for simulation to complete.
   */
  async waitForCompletion(): Promise<SimulationState> {
    return new Promise((resolve) => {
      if (!this.process || !this.state.running) {
        resolve(this.state);
        return;
      }
      this.process.on('exit', () => resolve(this.state));
    });
  }

  /**
   * Stop the simulation.
   */
  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.state.running = false;
    }
  }

  /**
   * Convert accumulated simulation actions into WorldEvents
   * for consumption by WorldMind agents.
   */
  toWorldEvents(): WorldEvent[] {
    return this.state.actions.map((action) =>
      createEvent({
        type: `social_${action.actionType.toLowerCase()}`,
        source: `collector:oasis-${this.config.platform}`,
        entities: [`agent:${action.agentId}`],
        data: {
          metadata: {
            agentId: action.agentId,
            agentName: action.agentName,
            platform: this.config.platform,
          },
          actionType: action.actionType,
          content: action.content,
          targetId: action.targetId,
          round: action.round,
          simulatedTime: action.timestamp,
        },
        importance: action.actionType === 'CREATE_POST' ? 0.8 : 0.3,
      }),
    );
  }

  /**
   * Get current simulation state.
   */
  getState(): SimulationState {
    return { ...this.state };
  }

  // ─── Internal ───────────────────────────────────────────────

  private handleEvent(json: string): void {
    try {
      const event = JSON.parse(json);

      if (event.type === 'action') {
        const action: SimulationAction = {
          round: event.round,
          agentId: event.agent_id,
          agentName: event.agent_name ?? `agent_${event.agent_id}`,
          actionType: event.action_type,
          content: event.content,
          targetId: event.target_id,
          timestamp: event.timestamp ?? new Date().toISOString(),
        };
        this.state.actions.push(action);
        this.state.totalActions++;
      } else if (event.type === 'round_end') {
        this.state.round = event.round;
      } else if (event.type === 'simulation_end') {
        this.state.running = false;
      }
    } catch {
      // Non-JSON output, ignore
    }
  }
}

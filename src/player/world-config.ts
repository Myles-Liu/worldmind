/**
 * World Configuration — purely file-driven.
 *
 * All world definitions live in JSON files under `worlds/`.
 * The engine reads them. Zero hardcoded presets in code.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────

export interface WorldSettings {
  name: string;
  description: string;
  language: string;
  culture?: string;
  platform: 'twitter' | 'reddit';
  agentDirective: string;
  agentCount: number;
  minutesPerRound: number;
  peakHours: [number, number];
  peakActivation: number;
  offPeakActivation: number;
  archetypes: AgentArchetype[];
}

export interface AgentArchetype {
  role: string;
  description: string;
  personality: string;
}

// ─── Loader ─────────────────────────────────────────────────────

const DEFAULTS: WorldSettings = {
  name: 'Unnamed World',
  description: '',
  language: 'English',
  platform: 'twitter',
  agentDirective: 'Stay in character.',
  agentCount: 10,
  minutesPerRound: 30,
  peakHours: [9, 22],
  peakActivation: 0.6,
  offPeakActivation: 0.15,
  archetypes: [],
};

/**
 * Load a world definition from a JSON file.
 * Accepts a file path or a world name (resolved from `worlds/` directory).
 */
export function loadWorld(pathOrName: string, worldsDir?: string): WorldSettings {
  const dir = worldsDir ?? join(process.cwd(), 'worlds');
  let filePath: string;

  if (existsSync(pathOrName)) {
    filePath = pathOrName;
  } else {
    // Try worlds/<name>.json
    filePath = join(dir, pathOrName.endsWith('.json') ? pathOrName : `${pathOrName}.json`);
  }

  if (!existsSync(filePath)) {
    throw new Error(`World not found: ${filePath}\nAvailable: ${listWorlds(dir).join(', ')}`);
  }

  const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  return { ...DEFAULTS, ...raw };
}

/**
 * List available world names from the worlds/ directory.
 */
export function listWorlds(worldsDir?: string): string[] {
  const dir = worldsDir ?? join(process.cwd(), 'worlds');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => basename(f, '.json'));
}

// ─── Profile Generator ─────────────────────────────────────────

export interface PlayerConfig {
  username: string;
  displayName: string;
  bio: string;
}

/**
 * Build a world-level context string from settings.
 * This is injected once into the global system prompt (NOT per-agent).
 * Contains language, culture, and behavioral directives.
 */
export function buildWorldContext(settings: WorldSettings): string {
  const parts: string[] = [];
  parts.push(`# WORLD CONTEXT`);
  parts.push(`You are in a community called "${settings.name}".`);
  if (settings.description) parts.push(settings.description);
  if (settings.language && settings.language !== 'English') {
    parts.push(`All communication must be in ${settings.language}.`);
  }
  if (settings.culture) parts.push(`Cultural context: ${settings.culture}`);
  if (settings.agentDirective) parts.push(settings.agentDirective);
  return parts.join('\n');
}

/**
 * Generate agent profile CSV from a WorldSettings object.
 * Language, culture, and global directives are NOT included here — they
 * belong in the world-level system prompt (see buildWorldContext).
 * Each agent's user_char contains ONLY their individual personality.
 */
export function generateProfileCSV(
  settings: WorldSettings,
  player?: PlayerConfig,
): string {
  const lines = ['username,description,user_char'];

  for (let i = 0; i < settings.agentCount; i++) {
    const arch = settings.archetypes[i % settings.archetypes.length];
    if (!arch) continue;
    const suffix = i >= settings.archetypes.length
      ? `_${Math.floor(i / settings.archetypes.length) + 1}`
      : '';
    const username = `${arch.role}${suffix}`;
    lines.push(
      `${username},${esc(arch.description)},${esc(arch.personality)}`,
    );
  }

  if (player) {
    lines.push(
      `${player.username},${esc(player.displayName)},${esc(player.bio)}`,
    );
  }

  return lines.join('\n') + '\n';
}

function esc(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

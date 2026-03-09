#!/usr/bin/env tsx
/**
 * Start a WorldMind Multiplayer Server
 *
 * Usage:
 *   npx tsx multiplayer/scripts/serve.ts --world cn-tech --port 3000
 *   npx tsx multiplayer/scripts/serve.ts --world cn-tech --port 3000 --round-interval 30
 *   npx tsx multiplayer/scripts/serve.ts --world cn-tech --port 3000 --no-npcs
 */

import { WorldEngine } from '../../src/player/engine.js';
import { WorldServer } from '../src/server.js';
import { OasisPlatformAdapter } from '../src/oasis-adapter.js';
import { loadWorld, generateProfileCSV, buildWorldContext } from '../../src/player/world-config.js';
import type { Persona } from '../src/types.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ─── Load env ───────────────────────────────────────────────────
try {
  const env = readFileSync(join(process.cwd(), '.env'), 'utf-8');
  for (const line of env.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#') && t.includes('=')) {
      const [k, ...v] = t.split('=');
      process.env[k!.trim()] = v.join('=').trim();
    }
  }
} catch {}

// ─── Args ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get = (f: string) => args.find((_, i) => args[i - 1] === `--${f}`);
const worldArg = get('world') ?? 'cn-tech';
const port = parseInt(get('port') ?? '3000');
const roundInterval = parseInt(get('round-interval') ?? '0');
const noNpcs = args.includes('--no-npcs');
const agentCountArg = get('agents');

const print = (m: string) => process.stdout.write(m + '\n');

// ─── Main ───────────────────────────────────────────────────────
async function main() {
  print('\n🌍 WorldMind Multiplayer Server');
  print('═'.repeat(40));

  const worldSettings = loadWorld(worldArg);
  if (agentCountArg) worldSettings.agentCount = parseInt(agentCountArg);

  const profileDir = join(process.cwd(), 'data/social');
  mkdirSync(profileDir, { recursive: true });
  const profilePath = join(profileDir, `serve_${Date.now()}.csv`);
  writeFileSync(profilePath, generateProfileCSV(worldSettings), 'utf-8');

  const worldContext = buildWorldContext(worldSettings);

  // Build NPC personas
  const npcs: Persona[] = [];
  if (!noNpcs) {
    for (let i = 0; i < worldSettings.agentCount; i++) {
      const arch = worldSettings.archetypes[i % worldSettings.archetypes.length];
      if (!arch) continue;
      const suffix = i >= worldSettings.archetypes.length
        ? `_${Math.floor(i / worldSettings.archetypes.length) + 1}` : '';
      npcs.push({ id: i, username: `${arch.role}${suffix}`, role: arch.role, personality: arch.personality });
    }
  }

  // Init OASIS
  const engine = new WorldEngine({
    platform: worldSettings.platform,
    agentCount: worldSettings.agentCount,
    profilePath,
    llm: {
      apiKey: process.env.WORLDMIND_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
      baseUrl: process.env.WORLDMIND_LLM_BASE_URL ?? process.env.OPENAI_API_BASE ?? '',
      model: process.env.WORLDMIND_LLM_MODEL ?? 'gpt-4o-mini',
    },
    worldContext,
  });

  print(`  World: ${worldSettings.name} (${worldSettings.language})`);
  print(`  NPCs: ${noNpcs ? 'off' : worldSettings.agentCount}`);
  print('  Starting OASIS...');
  await engine.init();

  // Remap IDs
  const agents = engine.getAgents(100);
  for (let i = 0; i < npcs.length && i < agents.length; i++) {
    npcs[i]!.id = agents[i]!.id;
  }

  const platform = new OasisPlatformAdapter(engine);

  // TODO: plug in NpcRuntime (DirectorRuntime adapter) for NPC auto-play
  // For now, NPCs are static — server only accepts player connections

  const server = new WorldServer({
    platform,
    worldContext,
    npcs,
    roundIntervalSec: roundInterval,
    maxPlayers: 50,
    onLog: (m) => print(`  ${m}`),
  });

  await server.start(port);
  print(`\n  ✓ ws://0.0.0.0:${port}`);
  print(`  Waiting for players...\n`);

  process.on('SIGINT', async () => {
    print('\nShutting down...');
    await server.stop();
    process.exit(0);
  });
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

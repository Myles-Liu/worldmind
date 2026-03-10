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
import { DirectorNpcRuntime } from '../src/director-runtime.js';
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
const maxPlayerSlots = parseInt(get('player-slots') ?? '5');
const playerWaitSec = parseInt(get('player-wait') ?? '30');

const print = (m: string) => process.stdout.write(m + '\n');

// ─── Main ───────────────────────────────────────────────────────
async function main() {
  print('\n🌍 WorldMind Multiplayer Server');
  print('═'.repeat(40));

  const worldSettings = loadWorld(worldArg);
  if (agentCountArg) worldSettings.agentCount = parseInt(agentCountArg);

  const profileDir = join(process.cwd(), 'data/social');
  mkdirSync(profileDir, { recursive: true });

  // Generate profile CSV with pre-allocated player slots
  // so OASIS registers them as real agents with IDs
  let profileCSV = generateProfileCSV(worldSettings);
  for (let i = 0; i < maxPlayerSlots; i++) {
    profileCSV += `\nplayer_${i},"Player ${i}","A real human exploring this simulation."`;
  }

  // Each run gets its own directory: data/social/2026-03-10-10-47-33/
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}-${String(now.getSeconds()).padStart(2,'0')}`;
  const runDir = join(profileDir, timestamp);
  mkdirSync(runDir, { recursive: true });

  const profilePath = join(runDir, 'profiles.csv');
  writeFileSync(profilePath, profileCSV, 'utf-8');

  const worldContext = buildWorldContext(worldSettings);

  // Total agents = NPCs + player slots
  const totalAgents = worldSettings.agentCount + maxPlayerSlots;

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
  const dbPath = join(runDir, 'world.db');
  const engine = new WorldEngine({
    platform: worldSettings.platform,
    agentCount: totalAgents,
    profilePath,
    dbPath,
    llm: {
      apiKey: process.env.WORLDMIND_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
      baseUrl: process.env.WORLDMIND_LLM_BASE_URL ?? process.env.OPENAI_API_BASE ?? '',
      model: process.env.WORLDMIND_LLM_MODEL ?? 'gpt-4o-mini',
    },
    worldContext,
  });

  print(`  World: ${worldSettings.name} (${worldSettings.language})`);
  print(`  NPCs: ${noNpcs ? 'off' : worldSettings.agentCount}`);
  print(`  Player slots: ${maxPlayerSlots}`);
  print(`  DB: ${dbPath}`);
  print('  Starting OASIS...');
  await engine.init();

  // Remap NPC IDs to actual OASIS agent IDs
  const agents = engine.getAgents(200);
  const npcIds: number[] = [];
  for (let i = 0; i < npcs.length && i < agents.length; i++) {
    npcs[i]!.id = agents[i]!.id;
    npcIds.push(agents[i]!.id);
  }

  // Pre-allocated player slot IDs (the agents after the NPCs)
  const playerSlotIds: number[] = [];
  for (let i = worldSettings.agentCount; i < agents.length && i < totalAgents; i++) {
    playerSlotIds.push(agents[i]!.id);
  }
  print(`  NPC IDs: ${npcIds.join(', ')}`);
  print(`  Player slot IDs: ${playerSlotIds.join(', ')}`);

  const platform = new OasisPlatformAdapter(engine, playerSlotIds);

  // Create DirectorNpcRuntime for NPC auto-play
  let npcRuntime: DirectorNpcRuntime | undefined;
  if (!noNpcs) {
    npcRuntime = new DirectorNpcRuntime({
      worldContext,
      llm: {
        apiKey: process.env.WORLDMIND_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
        baseURL: process.env.WORLDMIND_LLM_BASE_URL ?? process.env.OPENAI_API_BASE ?? 'https://api.openai.com/v1',
        model: process.env.WORLDMIND_LLM_MODEL ?? 'gpt-4o-mini',
      },
      memoryDir: join(runDir, 'memory'),
    });
  }

  const server = new WorldServer({
    platform,
    worldContext,
    npcs,
    npcRuntime,
    roundIntervalSec: roundInterval,
    maxPlayers: maxPlayerSlots,
    playerWaitMs: playerWaitSec * 1000,
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

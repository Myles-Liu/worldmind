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
import { OasisNpcRuntime } from '../src/oasis-npc-runtime.js';
import { loadWorld, generateProfileCSV, buildWorldContext } from '../../src/player/world-config.js';
import type { Persona } from '../src/types.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';

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
const host = get('host') ?? 'localhost';
const port = parseInt(get('port') ?? '3000');
const roundInterval = parseInt(get('round-interval') ?? '0');
const noNpcs = args.includes('--no-npcs');
const agentCountArg = get('agents');
const maxPlayerSlots = parseInt(get('player-slots') ?? '5');
const playerWaitSec = parseInt(get('player-wait') ?? '30');
const resumeDir = get('resume'); // path to previous run dir (e.g. data/social/2026-03-10-14-45-06)
const adminToken = get('admin-token') ?? randomBytes(12).toString('hex');

const print = (m: string) => process.stdout.write(m + '\n');

// ─── Main ───────────────────────────────────────────────────────
async function main() {
  print('\n🌍 WorldMind Multiplayer Server');
  print('═'.repeat(40));

  const worldSettings = loadWorld(worldArg);
  if (agentCountArg) worldSettings.agentCount = parseInt(agentCountArg);

  const profileDir = join(process.cwd(), 'data/social');
  mkdirSync(profileDir, { recursive: true });

  // Check for resume mode
  let importPath: string | undefined;
  if (resumeDir) {
    // Try both export filename conventions
    let exportFile = join(resumeDir, 'state.export.json');
    if (!existsSync(exportFile)) exportFile = join(resumeDir, 'export.json');
    if (existsSync(exportFile)) {
      importPath = exportFile;
      print(`  📦 Resuming from: ${resumeDir}`);
    } else {
      print(`  ⚠️ Resume requested but ${exportFile} not found, starting fresh`);
    }
  }

  // Generate profile CSV with pre-allocated player slots
  // so OASIS registers them as real agents with IDs
  let profileCSV = generateProfileCSV(worldSettings);
  for (let i = 0; i < maxPlayerSlots; i++) {
    profileCSV += `\nplayer_${i},"Player ${i}","A real human exploring this simulation.","Human player"`;
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
      npcs.push({ id: i, username: `${arch.role}${suffix}`, displayName: arch.description, role: arch.role, personality: arch.personality });
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

  // Import previous state if resuming
  if (importPath) {
    print('  Importing previous state...');
    const imported = await engine.importState(importPath);
    const summary = Object.entries(imported).map(([k, v]) => `${k}:${v}`).join(', ');
    print(`  ✓ Imported: ${summary}`);

    // Also copy NPC memory if available
    if (resumeDir) {
      const prevMemDir = join(resumeDir, 'memory');
      const newMemDir = join(runDir, 'memory');
      if (existsSync(prevMemDir)) {
        const { execSync } = await import('child_process');
        execSync(`cp -r "${prevMemDir}" "${newMemDir}"`, { timeout: 5000 });
        print('  ✓ NPC memory restored');
      }
    }
  }

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

  // Create NPC runtime — OASIS native mode (each agent thinks independently)
  let npcRuntime: OasisNpcRuntime | undefined;
  if (!noNpcs) {
    npcRuntime = new OasisNpcRuntime({
      engine,
      npcIds,
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
    adminToken,
    llm: {
      apiKey: process.env.WORLDMIND_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
      baseURL: process.env.WORLDMIND_LLM_BASE_URL ?? process.env.OPENAI_API_BASE ?? 'https://api.openai.com/v1',
      model: process.env.WORLDMIND_LLM_MODEL ?? 'gpt-4o-mini',
    },
    onLog: (m) => print(`  ${m}`),
  });

  await server.start(port, host);
  print(`\n  ✓ ws+http://${host}:${port}`);
  print(`  🔑 Admin token: ${adminToken}`);
  print(`  Waiting for players...\n`);

  process.on('SIGINT', async () => {
    print('\nShutting down...');

    // Auto-export state for future --resume
    const exportPath = join(runDir, 'state.export.json');
    try {
      const result = await engine.exportState(exportPath);
      print(`  ✓ State exported to ${result.path}`);
    } catch (e) {
      print(`  ⚠️ Export failed: ${e}`);
    }

    await server.stop();
    print(`\n  To resume: --resume ${runDir}`);
    process.exit(0);
  });
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

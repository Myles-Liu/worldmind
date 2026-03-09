#!/usr/bin/env tsx
/**
 * WorldMind Social Simulation — Runtime-agnostic CLI
 *
 * Uses the Orchestrator + AgentRuntime pattern.
 * Switch between runtimes with --runtime flag:
 *   --runtime director   (default) Batched LLM, efficient
 *   --runtime openclaw   One OpenClaw sub-session per agent
 *
 * Usage:
 *   npx tsx scripts/play-sim.ts --world cn-tech
 *   npx tsx scripts/play-sim.ts --world cn-tech --runtime openclaw
 *   npx tsx scripts/play-sim.ts --world cn-tech --rounds 5
 */

import { WorldEngine } from '../src/player/engine.js';
import { SimulationOrchestrator } from '../src/player/orchestrator.js';
import { DirectorRuntime } from '../src/player/runtime-director.js';
import type { AgentRuntime, AgentPersona } from '../src/player/agent-runtime.js';
import { loadWorld, listWorlds, generateProfileCSV, buildWorldContext } from '../src/player/world-config.js';
import type { Role } from '../src/player/types.js';
import { createInterface } from 'readline';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ─── Parse args ─────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag: string) => args.find((_, i) => args[i - 1] === `--${flag}`);

const worldArg = get('world') ?? 'cn-tech';
const runtimeArg = get('runtime') ?? 'director';
const agentCountArg = get('agents');
const autoRoundsArg = get('rounds');
const autoRounds = autoRoundsArg ? parseInt(autoRoundsArg) : 0;
const isAdmin = args.includes('--admin');
const role: Role = isAdmin ? 'admin' : 'player';
const playerName = get('name') ?? 'player';

if (worldArg === 'list') {
  console.log('Available worlds:', listWorlds().join(', '));
  process.exit(0);
}

// ─── Load env ───────────────────────────────────────────────────

function loadEnv() {
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
}
loadEnv();

// ─── Colors ─────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};
const print = (m: string) => process.stdout.write(m + '\n');
const header = (m: string) => print(`\n${c.bold}${c.cyan}${m}${c.reset}`);
const info = (m: string) => print(`  ${c.dim}${m}${c.reset}`);
const success = (m: string) => print(`  ${c.green}✓${c.reset} ${m}`);
const warn = (m: string) => print(`  ${c.yellow}⚠${c.reset} ${m}`);
const error = (m: string) => print(`  ${c.red}✗${c.reset} ${m}`);

// ─── Build Runtime ──────────────────────────────────────────────

function createRuntime(worldContext: string, worldName: string): AgentRuntime {
  switch (runtimeArg) {
    case 'director': {
      const memDir = join(process.cwd(), 'data/social/memory');
      mkdirSync(memDir, { recursive: true });
      return new DirectorRuntime({
        llm: {
          apiKey: process.env.WORLDMIND_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
          baseURL: process.env.WORLDMIND_LLM_BASE_URL ?? process.env.OPENAI_API_BASE ?? 'https://api.openai.com/v1',
          model: process.env.WORLDMIND_LLM_MODEL ?? 'gpt-4o-mini',
        },
        worldContext,
        memoryPath: join(memDir, `sim_${worldName}_memory.json`),
      });
    }
    case 'openclaw': {
      // Dynamic import to avoid hard dependency
      // For now, fallback to director with a warning
      warn('OpenClaw runtime: requires OpenClaw gateway running. Using sessions_spawn API.');
      // TODO: implement when testing with live OpenClaw gateway
      throw new Error('OpenClaw runtime not yet wired to live gateway. Use --runtime director for now.');
    }
    default:
      throw new Error(`Unknown runtime: ${runtimeArg}. Available: director, openclaw`);
  }
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  print(`\n${c.bold}${c.magenta}🌍 WorldMind Social Simulation${c.reset}`);
  print(`${c.dim}Runtime: ${runtimeArg} | Role: ${role}${c.reset}`);
  print(`${'═'.repeat(50)}`);

  // Load world
  let worldSettings;
  try {
    worldSettings = loadWorld(worldArg);
  } catch (e) {
    error((e as Error).message);
    process.exit(1);
  }
  if (agentCountArg) worldSettings.agentCount = parseInt(agentCountArg);

  // Generate profiles
  const profileDir = join(process.cwd(), 'data/social');
  mkdirSync(profileDir, { recursive: true });
  const profilePath = join(profileDir, `sim_${Date.now()}.csv`);
  const playerConfig = role === 'player'
    ? { username: playerName, displayName: playerName, bio: 'A real human exploring this simulation.' }
    : undefined;
  writeFileSync(profilePath, generateProfileCSV(worldSettings, playerConfig), 'utf-8');

  const worldContext = buildWorldContext(worldSettings);

  // Build personas
  const personas: AgentPersona[] = [];
  for (let i = 0; i < worldSettings.agentCount; i++) {
    const arch = worldSettings.archetypes[i % worldSettings.archetypes.length];
    if (!arch) continue;
    const suffix = i >= worldSettings.archetypes.length
      ? `_${Math.floor(i / worldSettings.archetypes.length) + 1}`
      : '';
    personas.push({
      id: i, // remapped after engine init
      username: `${arch.role}${suffix}`,
      role: arch.role,
      personality: arch.personality,
    });
  }

  // Init OASIS engine
  const engine = new WorldEngine({
    platform: worldSettings.platform,
    agentCount: worldSettings.agentCount + (playerConfig ? 1 : 0),
    profilePath,
    llm: {
      apiKey: process.env.WORLDMIND_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
      baseUrl: process.env.WORLDMIND_LLM_BASE_URL ?? process.env.OPENAI_API_BASE ?? '',
      model: process.env.WORLDMIND_LLM_MODEL ?? 'gpt-4o-mini',
    },
    worldContext,
    player: playerConfig,
  });

  info(`World: ${worldSettings.name} (${worldSettings.language})`);
  info(`Agents: ${worldSettings.agentCount} | Runtime: ${runtimeArg}`);
  info('Initializing OASIS platform...');

  try { await engine.init(); } catch (e) {
    error(`Init failed: ${(e as Error).message}`);
    process.exit(1);
  }

  const state = engine.getWorldState();
  success(`Platform ready! ${state.totalAgents} agents registered.`);

  // Remap persona IDs to actual OASIS agent IDs
  const agents = engine.getAgents(100);
  for (let i = 0; i < personas.length && i < agents.length; i++) {
    personas[i]!.id = agents[i]!.id;
  }

  // Create runtime + orchestrator
  const runtime = createRuntime(worldContext, worldArg);
  const orchestrator = new SimulationOrchestrator({
    engine,
    runtime,
    worldContext,
    onLog: (msg) => print(`  ${msg}`),
  });

  await orchestrator.init(personas);

  // ─── Auto mode ──────────────────────────────────────────────

  if (autoRounds > 0) {
    header(`Auto-running ${autoRounds} rounds...`);
    const results = await orchestrator.run(autoRounds);

    header('Final State');
    const fs = engine.getWorldState();
    print(`  Rounds: ${orchestrator.currentRound}`);
    print(`  Posts: ${fs.totalPosts}  Comments: ${fs.totalComments}  Likes: ${fs.totalLikes}  Follows: ${fs.totalFollows}`);
    print('');

    const posts = engine.getFeed(20);
    if (posts.length > 0) {
      header('📰 All Posts');
      for (const p of posts) {
        print(`  ${c.bold}@${p.authorName}${c.reset}`);
        print(`  ${p.content}`);
        print(`  ${c.dim}❤️ ${p.likes}  💬 ${p.comments}${c.reset}\n`);
      }
    }

    await orchestrator.shutdown();
    process.exit(0);
  }

  // ─── Interactive mode ───────────────────────────────────────

  header('Commands');
  print(`  ${c.bold}step${c.reset} [N]    — Run N rounds (default 1)`);
  print(`  ${c.bold}post${c.reset} <text> — Post as player`);
  print(`  ${c.bold}feed${c.reset}        — View feed`);
  print(`  ${c.bold}agents${c.reset}      — List agents`);
  print(`  ${c.bold}status${c.reset}      — World overview`);
  print(`  ${c.bold}quit${c.reset}        — Exit`);
  print('');

  const rl = createInterface({
    input: process.stdin, output: process.stdout,
    prompt: `${c.magenta}sim>${c.reset} `,
  });
  rl.prompt();

  rl.on('line', async (input) => {
    const line = input.trim();
    if (!line) { rl.prompt(); return; }
    const [cmd, ...rest] = line.split(/\s+/);
    const text = rest.join(' ');

    try {
      switch (cmd) {
        case 'step': {
          const n = parseInt(text) || 1;
          await orchestrator.run(n);
          break;
        }
        case 'post': {
          if (!text) { warn('Usage: post <text>'); break; }
          if (!playerConfig) { warn('No player in admin mode.'); break; }
          await engine.playerAct({ type: 'post', content: text });
          success('Posted! Running agent reactions...');
          await orchestrator.step();
          break;
        }
        case 'feed': {
          const posts = engine.getFeed(15);
          header('📰 Feed');
          if (!posts.length) { info('No posts yet.'); break; }
          for (const p of posts) {
            const a = p.isPlayer ? `${c.green}@${p.authorName} (you)${c.reset}` : `@${p.authorName}`;
            print(`  ${c.bold}#${p.id}${c.reset} ${a}`);
            print(`  ${p.content}`);
            print(`  ${c.dim}❤️ ${p.likes}  💬 ${p.comments}  🔄 ${p.reposts}${c.reset}\n`);
          }
          break;
        }
        case 'agents': {
          const al = engine.getAgents(20);
          header('🤖 Agents');
          for (const a of al) {
            const tag = a.isPlayer ? ` ${c.green}(you)${c.reset}` : '';
            print(`  #${a.id} @${a.username}${tag} — ${a.bio.slice(0, 60)}`);
          }
          break;
        }
        case 'status': {
          const s = engine.getWorldState();
          header('🌍 Status');
          print(`  Round: ${orchestrator.currentRound} | Runtime: ${runtimeArg}`);
          print(`  Agents: ${s.totalAgents} | Posts: ${s.totalPosts} | Comments: ${s.totalComments}`);
          print(`  Likes: ${s.totalLikes} | Follows: ${s.totalFollows}`);
          break;
        }
        case 'quit': case 'exit':
          await orchestrator.shutdown();
          process.exit(0);
        default:
          warn(`Unknown: ${cmd}`);
      }
    } catch (e) {
      error(`${(e as Error).message}`);
    }
    rl.prompt();
  });

  rl.on('close', async () => {
    await orchestrator.shutdown();
    process.exit(0);
  });
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

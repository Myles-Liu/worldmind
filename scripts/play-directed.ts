#!/usr/bin/env tsx
/**
 * WorldMind Directed Mode — "One Mind, Many Voices"
 *
 * Same interactive CLI as play.ts, but OASIS agents don't use their own LLM.
 * Instead, AgentDirector makes all decisions in batched LLM calls,
 * then submits them as ManualActions to OASIS.
 *
 * Usage:
 *   npx tsx scripts/play-directed.ts --world cn-tech
 *   npx tsx scripts/play-directed.ts --world cn-tech --admin
 *   npx tsx scripts/play-directed.ts --world cn-tech --rounds 5
 */

import { WorldEngine } from '../src/player/engine.js';
import { AgentDirector, type AgentPersona, type AgentDecision } from '../src/player/agent-director.js';
import { AgentMemoryManager } from '../src/player/memory.js';
import { LLMClient } from '../src/llm/client.js';
import { loadWorld, listWorlds, generateProfileCSV, buildWorldContext } from '../src/player/world-config.js';
import type { Role, PlayerAction, AdminAction } from '../src/player/types.js';
import { createInterface } from 'readline';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// ─── Parse args ─────────────────────────────────────────────────

const args = process.argv.slice(2);
const isAdmin = args.includes('--admin');
const role: Role = isAdmin ? 'admin' : 'player';

const agentCountArg = args.find((_, i) => args[i - 1] === '--agents');
const agentCount = agentCountArg ? parseInt(agentCountArg) : 10;

const nameArg = args.find((_, i) => args[i - 1] === '--name');
const playerName = nameArg ?? 'player';

const worldArg = args.find((_, i) => args[i - 1] === '--world') ?? 'cn-tech';

const autoRoundsArg = args.find((_, i) => args[i - 1] === '--rounds');
const autoRounds = autoRoundsArg ? parseInt(autoRoundsArg) : 0;

if (worldArg === 'list') {
  const worlds = listWorlds();
  console.log('Available worlds:', worlds.join(', '));
  process.exit(0);
}

// ─── Load env ───────────────────────────────────────────────────

function loadEnv() {
  try {
    const env = readFileSync(join(process.cwd(), '.env'), 'utf-8');
    for (const line of env.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [k, ...v] = trimmed.split('=');
        process.env[k!.trim()] = v.join('=').trim();
      }
    }
  } catch {}
}
loadEnv();

// ─── Colors ─────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function print(msg: string) { process.stdout.write(msg + '\n'); }
function header(msg: string) { print(`\n${c.bold}${c.cyan}${msg}${c.reset}`); }
function info(msg: string) { print(`  ${c.dim}${msg}${c.reset}`); }
function success(msg: string) { print(`  ${c.green}✓${c.reset} ${msg}`); }
function warn(msg: string) { print(`  ${c.yellow}⚠${c.reset} ${msg}`); }
function error(msg: string) { print(`  ${c.red}✗${c.reset} ${msg}`); }

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  print(`\n${c.bold}${c.magenta}🌍 WorldMind — Directed Mode (${role})${c.reset}`);
  print(`${c.dim}One Mind, Many Voices${c.reset}`);
  print(`${'═'.repeat(50)}`);

  // Load world config
  let worldSettings;
  try {
    worldSettings = loadWorld(worldArg);
  } catch (e) {
    error((e as Error).message);
    process.exit(1);
  }

  if (agentCountArg) worldSettings.agentCount = agentCount;

  // Generate profiles
  const profileDir = join(process.cwd(), 'data/social');
  mkdirSync(profileDir, { recursive: true });
  const profilePath = join(profileDir, `directed_${Date.now()}.csv`);
  const playerConfig = role === 'player' ? {
    username: playerName,
    displayName: playerName,
    bio: 'A real human exploring this simulation.',
  } : undefined;
  writeFileSync(profilePath, generateProfileCSV(worldSettings, playerConfig), 'utf-8');

  const worldContext = buildWorldContext(worldSettings);

  // Build personas from world settings archetypes
  const personas: AgentPersona[] = [];
  for (let i = 0; i < worldSettings.agentCount; i++) {
    const arch = worldSettings.archetypes[i % worldSettings.archetypes.length];
    if (!arch) continue;
    const suffix = i >= worldSettings.archetypes.length
      ? `_${Math.floor(i / worldSettings.archetypes.length) + 1}`
      : '';
    personas.push({
      id: i, // will be remapped after init
      username: `${arch.role}${suffix}`,
      role: arch.role,
      personality: arch.personality,
    });
  }

  // Initialize engine (OASIS subprocess) — use timestamped DB
  const dbPath = join(profileDir, `world_${Date.now()}.db`);
  const engine = new WorldEngine({
    platform: worldSettings.platform,
    agentCount: worldSettings.agentCount + (playerConfig ? 1 : 0),
    profilePath,
    dbPath,
    llm: {
      apiKey: process.env.WORLDMIND_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
      baseUrl: process.env.WORLDMIND_LLM_BASE_URL ?? process.env.OPENAI_API_BASE ?? '',
      model: process.env.WORLDMIND_LLM_MODEL ?? 'gpt-4o-mini',
    },
    worldContext,
    player: playerConfig,
  });

  info(`World: ${worldSettings.name} (${worldSettings.language})`);
  info(`Agents: ${worldSettings.agentCount} (directed mode)`);
  info('Initializing OASIS platform...');

  try {
    await engine.init();
  } catch (e) {
    error(`Failed to initialize: ${(e as Error).message}`);
    process.exit(1);
  }

  const state = engine.getWorldState();
  success(`Platform ready! ${state.totalAgents} agents registered.`);

  // Remap persona IDs to actual OASIS agent IDs
  const agents = engine.getAgents(100);
  for (let i = 0; i < personas.length && i < agents.length; i++) {
    personas[i]!.id = agents[i]!.id;
  }

  // Initialize director
  const memoryDir = join(process.cwd(), 'data/social/memory');
  mkdirSync(memoryDir, { recursive: true });
  const memoryPath = join(memoryDir, `directed_${worldArg}_memory.json`);

  const memoryManager = new AgentMemoryManager({
    maxEntriesPerAgent: 50,
    savePath: memoryPath,
  });

  const llm = new LLMClient({
    apiKey: process.env.WORLDMIND_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
    baseURL: process.env.WORLDMIND_LLM_BASE_URL ?? process.env.OPENAI_API_BASE ?? 'https://api.openai.com/v1',
    model: process.env.WORLDMIND_LLM_MODEL ?? 'gpt-4o-mini',
  });

  const director = new AgentDirector({
    llm,
    memoryManager,
    worldContext,
    personas,
  });

  let round = 0;

  /**
   * Run one directed round:
   * 1. Gather feeds/notifications from OASIS for each agent
   * 2. Director decides actions for all agents
   * 3. Submit as ManualAction to OASIS
   */
  async function runDirectedRound(): Promise<AgentDecision[]> {
    round++;
    info(`\n─── Round ${round} ───`);

    // Select active agents (randomize who acts this round, ~60-80%)
    const activeCount = Math.max(3, Math.floor(personas.length * (0.6 + Math.random() * 0.2)));
    const shuffled = [...personas].sort(() => Math.random() - 0.5);
    const active = shuffled.slice(0, activeCount);

    info(`${active.length}/${personas.length} agents active this round`);

    // Gather context for each active agent (sequential to avoid stdout race)
    const agentInputs = [];
    for (const persona of active) {
      const feedRaw = await engine.queryAgentFeed(persona.id, 8);
      const notifsRaw = await engine.queryAgentNotifications(persona.id, 5);

      const feed = feedRaw.map(f => ({
        postId: f.post_id,
        authorName: f.author_name,
        content: f.content,
        likes: f.num_likes,
        comments: f.num_comments,
      }));

      const notifications = notifsRaw.map(n => `${n.from_agent} ${n.type}: ${n.content}`.trim());
      const memory = memoryManager.getMemorySummary(persona.id);

      agentInputs.push({ persona, feed, memory, notifications });
    }

    // Director decides
    info('Director thinking...');
    const decisions = await director.directRound({
      round,
      worldContext,
      agents: agentInputs,
    });

    // Log decisions
    for (const d of decisions) {
      const persona = personas.find(p => p.id === d.agentId);
      const name = persona?.username ?? `#${d.agentId}`;
      const icon = d.action === 'post' ? '📝' : d.action === 'comment' ? '💬'
        : d.action === 'like' ? '❤️' : d.action === 'follow' ? '👤' : '😴';
      const detail = d.content ? `: ${d.content.slice(0, 60)}` : '';
      print(`    ${icon} @${name} → ${d.action}${detail}`);
      if (d.reasoning) print(`       ${c.dim}(${d.reasoning})${c.reset}`);
    }

    // Submit to OASIS
    const actionDecisions = decisions.filter(d => d.action !== 'do_nothing');
    if (actionDecisions.length > 0) {
      const result = await engine.directedStep(actionDecisions);
      success(`Executed ${result.executed} actions, ${result.skipped} skipped`);
    } else {
      info('All agents chose to lurk this round.');
    }

    // Save memory
    memoryManager.save();

    return decisions;
  }

  // ─── Auto mode (--rounds N) ─────────────────────────────────

  if (autoRounds > 0) {
    header(`Auto-running ${autoRounds} rounds...`);
    for (let i = 0; i < autoRounds; i++) {
      await runDirectedRound();
    }

    // Print final summary
    header('Final State');
    const finalState = engine.getWorldState();
    print(`  Rounds: ${round}`);
    print(`  Posts: ${finalState.totalPosts}`);
    print(`  Comments: ${finalState.totalComments}`);
    print(`  Likes: ${finalState.totalLikes}`);
    print(`  Follows: ${finalState.totalFollows}`);
    print('');

    // Show all posts
    const posts = engine.getFeed(20);
    if (posts.length > 0) {
      header('📰 All Posts');
      for (const p of posts) {
        print(`  ${c.bold}@${p.authorName}${c.reset}`);
        print(`  ${p.content}`);
        print(`  ${c.dim}❤️ ${p.likes}  💬 ${p.comments}${c.reset}\n`);
      }
    }

    await engine.shutdown();
    process.exit(0);
  }

  // ─── Interactive mode ─────────────────────────────────────────

  print('');
  header('Commands');
  print(`  ${c.bold}step${c.reset} [N]           — Run N directed rounds (default 1)`);
  print(`  ${c.bold}post${c.reset} <text>        — Post as player (if player mode)`);
  print(`  ${c.bold}feed${c.reset}               — View feed`);
  print(`  ${c.bold}agents${c.reset}             — List agents`);
  print(`  ${c.bold}status${c.reset}             — World overview`);
  print(`  ${c.bold}memory${c.reset} <agent_id>  — View agent's memory`);
  print(`  ${c.bold}quit${c.reset}               — Exit`);
  print('');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.magenta}director>${c.reset} `,
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
          for (let i = 0; i < n; i++) {
            await runDirectedRound();
          }
          break;
        }
        case 'post': {
          if (!text) { warn('Usage: post <text>'); break; }
          if (!playerConfig) { warn('No player in admin mode.'); break; }
          await engine.playerAct({ type: 'post', content: text });
          success('Posted! Running agent reactions...');
          await runDirectedRound();
          break;
        }
        case 'feed': {
          const posts = engine.getFeed(15);
          header('📰 Feed');
          if (posts.length === 0) { info('No posts yet. Run "step" first.'); break; }
          for (const p of posts) {
            const author = p.isPlayer
              ? `${c.bold}${c.green}@${p.authorName} (you)${c.reset}`
              : `${c.bold}@${p.authorName}${c.reset}`;
            print(`  #${p.id} ${author}`);
            print(`  ${p.content}`);
            print(`  ${c.dim}❤️ ${p.likes}  💬 ${p.comments}  🔄 ${p.reposts}${c.reset}\n`);
          }
          break;
        }
        case 'agents': {
          const agentList = engine.getAgents(20);
          header('🤖 Agents');
          for (const a of agentList) {
            const tag = a.isPlayer ? ` ${c.green}(you)${c.reset}` : '';
            print(`  #${a.id} @${a.username}${tag} — ${a.bio.slice(0, 60)}`);
          }
          print('');
          break;
        }
        case 'status': {
          const s = engine.getWorldState();
          header('🌍 World Status');
          print(`  Round: ${round}`);
          print(`  Agents: ${s.totalAgents} (${personas.length} directed)`);
          print(`  Posts: ${s.totalPosts}`);
          print(`  Comments: ${s.totalComments}`);
          print(`  Likes: ${s.totalLikes}`);
          print(`  Follows: ${s.totalFollows}`);
          print('');
          break;
        }
        case 'memory': {
          const agentId = parseInt(text);
          if (isNaN(agentId)) { warn('Usage: memory <agent_id>'); break; }
          const mem = memoryManager.getMemorySummary(agentId);
          const persona = personas.find(p => p.id === agentId);
          header(`🧠 Memory: @${persona?.username ?? agentId}`);
          print(mem || '  (no memory yet)');
          print('');
          break;
        }
        case 'quit':
        case 'exit':
          info('Saving memory & shutting down...');
          memoryManager.save();
          await engine.shutdown();
          process.exit(0);
          break;
        default:
          warn(`Unknown: ${cmd}. Commands: step, post, feed, agents, status, memory, quit`);
      }
    } catch (e) {
      error(`Error: ${(e as Error).message}`);
    }

    rl.prompt();
  });

  rl.on('close', async () => {
    memoryManager.save();
    await engine.shutdown();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

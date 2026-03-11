#!/usr/bin/env tsx
/**
 * WorldMind — OASIS Native Mode
 *
 * Uses OASIS's native LLM-driven agents. No director, no batch decisions.
 * Each agent uses its own system prompt (built from world config).
 *
 * Usage:
 *   npx tsx scripts/play-directed.ts --world marvel
 *   npx tsx scripts/play-directed.ts --world marvel --admin
 *   npx tsx scripts/play-directed.ts --world marvel --rounds 10
 */

import { WorldEngine } from '../src/player/engine.js';
import { loadWorld, listWorlds, generateProfileCSV, buildWorldContext } from '../src/player/world-config.js';
import type { Role } from '../src/player/types.js';
import { createInterface } from 'readline';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
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

const roundsArg = args.find((_, i) => args[i - 1] === '--rounds');
const rounds = roundsArg ? parseInt(roundsArg) : 0;

const resumeArg = args.find((_, i) => args[i - 1] === '--resume');
// --resume can be a full path to export.json, or a run directory name (e.g. 2026-03-11-12-28-29)
let resumePath: string | undefined;
if (resumeArg) {
  if (resumeArg.endsWith('.json')) {
    resumePath = resumeArg;
  } else {
    // Treat as run directory name under data/social/
    resumePath = join(process.cwd(), 'data/social', resumeArg, 'export.json');
  }
}

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
function error(msg: string) { print(`  ${c.red}✗${c.reset} ${msg}`); }

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  print(`\n${c.bold}${c.magenta}🌍 WorldMind — OASIS Native${c.reset}`);
  print(`${c.dim}Each agent thinks for itself.${c.reset}`);
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

  // Each run gets its own directory
  const profileDir = join(process.cwd(), 'data/social');
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}-${String(now.getSeconds()).padStart(2,'0')}`;
  const runDir = join(profileDir, timestamp);
  mkdirSync(runDir, { recursive: true });

  const profilePath = join(runDir, 'profiles.csv');
  const playerConfig = role === 'player' ? {
    username: playerName,
    displayName: playerName,
    bio: '一个真实的人类玩家，正在探索这个模拟世界。',
  } : undefined;
  writeFileSync(profilePath, generateProfileCSV(worldSettings, playerConfig), 'utf-8');

  // Build world context (injected into each agent's system prompt by OASIS)
  const worldContext = buildWorldContext(worldSettings);

  // Initialize engine (OASIS subprocess)
  const dbPath = join(runDir, 'world.db');
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
  info(`Agents: ${worldSettings.agentCount}`);
  info('Initializing OASIS platform...');

  try {
    await engine.init();
  } catch (e) {
    error(`Failed to initialize: ${(e as Error).message}`);
    process.exit(1);
  }

  const state = engine.getWorldState();
  success(`Platform ready! ${state.totalAgents} agents registered.`);

  // Resume from previous world state if --resume provided
  if (resumePath) {
    info(`Resuming from: ${resumePath}`);
    try {
      const imported = await engine.importState(resumePath);
      const entries = Object.entries(imported);
      if (entries.length > 0) {
        success(`Imported: ${entries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
      } else {
        error('Import returned empty — file may not exist or be malformed');
      }
    } catch (e) {
      error(`Failed to import: ${(e as Error).message}`);
    }
  }

  // ─── Run mode ─────────────────────────────────────────────────

  if (rounds > 0) {
    header(`Running ${rounds} rounds (OASIS native)...`);
    for (let i = 0; i < rounds; i++) {
      const roundNum = i + 1;
      info(`\n─── Round ${roundNum} ───`);
      await engine.adminAct({ type: 'step', rounds: 1 });
    }

    // Final state
    header('Final State');
    const finalState = engine.getWorldState();
    print(`  Rounds: ${rounds}`);
    print(`  Posts: ${finalState.totalPosts}`);
    print(`  Comments: ${finalState.totalComments}`);
    print(`  Likes: ${finalState.totalLikes}`);
    print(`  Follows: ${finalState.totalFollows}`);
    print(`  Groups: ${finalState.totalGroups}`);
    print(`  Group Messages: ${finalState.totalGroupMessages}`);

    // Show groups
    if (finalState.totalGroups > 0) {
      header('💬 Groups');
      const groups = engine.getGroups();
      for (const g of groups) {
        print(`  ${c.bold}${g.name}${c.reset} (${g.messages.length} messages)`);
        for (const m of g.messages) {
          print(`    └─ @${m.sender}: ${m.content.slice(0, 60)}`);
        }
      }
    }

    // Show trace summary
    header('📋 Action Summary');
    const traces = engine.getTrace(50);
    const actionCounts = new Map<string, number>();
    for (const t of traces) {
      actionCounts.set(t.action, (actionCounts.get(t.action) ?? 0) + 1);
    }
    for (const [action, count] of [...actionCounts.entries()].sort((a, b) => b[1] - a[1])) {
      print(`  ${action}: ${count}`);
    }

    // Export world state
    try {
      const exported = await engine.exportState(join(runDir, 'export.json'));
      success(`World state exported to ${exported.path}`);
    } catch { info('Export skipped (engine shutting down)'); }

    const posts = engine.getFeed(20);
    if (posts.length > 0) {
      header('📰 Recent Posts');
      for (const p of posts) {
        print(`  ${c.bold}@${p.authorName}${c.reset}`);
        print(`  ${p.content}`);
        // Fetch comments for this post
        const full = engine.getPost(p.id);
        if (full && full.comments.length > 0) {
          for (const cm of full.comments) {
            print(`     └─ @${cm.authorName}: ${cm.content}`);
          }
        }
        print(`  ${c.dim}❤️ ${p.likes}  💬 ${p.comments}${c.reset}\n`);
      }
    }

    await engine.shutdown();
    process.exit(0);
  }

  // ─── Interactive mode ─────────────────────────────────────────

  print('');
  header('Commands');
  print(`  ${c.bold}step${c.reset} [N]         — Run N rounds (default 1)`);
  print(`  ${c.bold}feed${c.reset}             — View feed`);
  print(`  ${c.bold}agents${c.reset}           — List agents`);
  print(`  ${c.bold}groups${c.reset}           — List groups and messages`);
  print(`  ${c.bold}graph${c.reset}            — Show follow graph`);
  print(`  ${c.bold}trace${c.reset} [N]        — Show recent actions (default 20)`);
  print(`  ${c.bold}export${c.reset}           — Export world state to JSON`);
  print(`  ${c.bold}resume${c.reset} <path>     — Import world state from export.json`);
  print(`  ${c.bold}status${c.reset}           — World overview`);
  print(`  ${c.bold}post${c.reset} <text>      — Post as player (if player mode)`);
  print(`  ${c.bold}quit${c.reset}             — Exit`);
  print('');

  let round = 0;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.magenta}worldmind>${c.reset} `,
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
            round++;
            info(`\n─── Round ${round} ───`);
            await engine.adminAct({ type: 'step', rounds: 1 });
          }
          break;
        }
        case 'feed': {
          const posts = engine.getFeed(15);
          header('📰 Feed');
          if (posts.length === 0) { info('No posts yet.'); break; }
          for (const p of posts) {
            const author = p.isPlayer
              ? `${c.bold}${c.green}@${p.authorName} (you)${c.reset}`
              : `${c.bold}@${p.authorName}${c.reset}`;
            print(`  #${p.id} ${author}`);
            print(`  ${p.content}`);
            // Fetch and show comments
            const full = engine.getPost(p.id);
            if (full && full.comments.length > 0) {
              for (const cm of full.comments) {
                print(`     └─ @${cm.authorName}: ${cm.content}`);
              }
            }
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
        case 'groups': {
          const groups = engine.getGroups();
          header('💬 Groups');
          if (groups.length === 0) { info('No groups yet.'); break; }
          for (const g of groups) {
            print(`  ${c.bold}${g.name}${c.reset} (${g.messages.length} messages)`);
            for (const m of g.messages) {
              print(`    └─ @${m.sender}: ${m.content}`);
            }
            print('');
          }
          break;
        }
        case 'graph': {
          const follows = engine.getFollowGraph();
          header('🔗 Follow Graph');
          if (follows.length === 0) { info('No follow relationships.'); break; }
          // Group by follower
          const byFollower = new Map<string, string[]>();
          for (const f of follows) {
            if (!byFollower.has(f.follower)) byFollower.set(f.follower, []);
            byFollower.get(f.follower)!.push(f.followee);
          }
          for (const [follower, followees] of byFollower) {
            print(`  ${c.bold}@${follower}${c.reset} → ${followees.map(f => `@${f}`).join(', ')}`);
          }
          print('');
          break;
        }
        case 'trace': {
          const limit = parseInt(text) || 20;
          const traces = engine.getTrace(limit);
          header(`📋 Recent Actions (last ${limit})`);
          if (traces.length === 0) { info('No actions recorded.'); break; }
          for (const t of traces) {
            const icon = t.action === 'create_post' ? '📝'
              : t.action === 'create_comment' ? '💬'
              : t.action === 'like_post' ? '❤️'
              : t.action === 'quote_post' ? '🔄'
              : t.action === 'repost' ? '🔁'
              : t.action === 'follow' ? '👤'
              : t.action.includes('group') ? '👥'
              : '🔸';
            print(`  ${icon} ${c.bold}@${t.agent}${c.reset} ${t.action} ${c.dim}${t.info}${c.reset}`);
          }
          print('');
          break;
        }
        case 'export': {
          const exported = await engine.exportState(join(runDir, 'export.json'));
          success(`Exported to ${exported.path}`);
          break;
        }
        case 'resume': {
          if (!text) { error('Usage: resume <path-to-export.json or run-dir-name>'); break; }
          const rPath = text.endsWith('.json') ? text : join(process.cwd(), 'data/social', text, 'export.json');
          try {
            const imported = await engine.importState(rPath);
            const entries = Object.entries(imported);
            if (entries.length > 0) {
              success(`Imported: ${entries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
            } else {
              error('Import returned empty');
            }
          } catch (e) {
            error(`Failed: ${(e as Error).message}`);
          }
          break;
        }
        case 'status': {
          const s = engine.getWorldState();
          header('🌍 World Status');
          print(`  Round: ${round}`);
          print(`  Agents: ${s.totalAgents}`);
          print(`  Posts: ${s.totalPosts}`);
          print(`  Comments: ${s.totalComments}`);
          print(`  Likes: ${s.totalLikes}`);
          print(`  Follows: ${s.totalFollows}`);
          print('');
          break;
        }
        case 'post': {
          if (!text) { error('Usage: post <text>'); break; }
          if (!playerConfig) { error('No player in admin mode.'); break; }
          await engine.playerAct({ type: 'post', content: text });
          success('Posted!');
          break;
        }
        case 'quit':
        case 'exit':
          info('Shutting down...');
          await engine.shutdown();
          process.exit(0);
          break;
        default:
          error(`Unknown: ${cmd}. Commands: step, feed, agents, status, post, quit`);
      }
    } catch (e) {
      error(`Error: ${(e as Error).message}`);
    }

    rl.prompt();
  });

  rl.on('close', async () => {
    await engine.shutdown();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

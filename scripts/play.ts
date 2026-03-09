#!/usr/bin/env tsx
/**
 * WorldMind Interactive CLI
 *
 * Usage:
 *   npx tsx scripts/play.ts                    # Player mode, 10 agents
 *   npx tsx scripts/play.ts --admin            # Admin/God mode
 *   npx tsx scripts/play.ts --agents 50        # 50 AI agents
 *   npx tsx scripts/play.ts --name "Myles"     # Set player name
 */

import { WorldEngine } from '../src/player/engine.js';
import type { Role, PlayerAction, AdminAction, Post } from '../src/player/types.js';
import {
  createWorldSettings, generateProfileCSV,
  PRESET_CN_TECH, PRESET_EN_TECH, PRESET_CN_FINANCE,
  type WorldSettings,
} from '../src/player/world-config.js';
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

// World preset: --world cn-tech | en-tech | cn-finance
const worldArg = args.find((_, i) => args[i - 1] === '--world');
const presets: Record<string, Partial<WorldSettings>> = {
  'cn-tech': PRESET_CN_TECH,
  'en-tech': PRESET_EN_TECH,
  'cn-finance': PRESET_CN_FINANCE,
};
const selectedPreset = presets[worldArg ?? 'cn-tech'] ?? PRESET_CN_TECH;

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

// ─── Render helpers ─────────────────────────────────────────────

function renderPost(post: Post, index?: number) {
  const prefix = index != null ? `${c.dim}#${post.id}${c.reset} ` : '';
  const author = post.isPlayer
    ? `${c.bold}${c.green}@${post.authorName} (you)${c.reset}`
    : `${c.bold}@${post.authorName}${c.reset}`;
  print(`  ${prefix}${author}`);
  print(`  ${post.content}`);
  print(`  ${c.dim}❤️ ${post.likes}  💬 ${post.comments}  🔄 ${post.reposts}${c.reset}`);
  print('');
}

// ─── Help ───────────────────────────────────────────────────────

function showHelp() {
  header('Commands');
  if (role === 'player') {
    print(`  ${c.bold}post${c.reset} <text>        — Post something`);
    print(`  ${c.bold}comment${c.reset} <id> <text> — Comment on a post`);
    print(`  ${c.bold}like${c.reset} <id>           — Like a post`);
    print(`  ${c.bold}follow${c.reset} <id>         — Follow a user`);
    print(`  ${c.bold}feed${c.reset}                — View your feed`);
    print(`  ${c.bold}notifs${c.reset}              — View notifications`);
    print(`  ${c.bold}me${c.reset}                  — Your profile`);
    print(`  ${c.bold}wait${c.reset}                — Skip turn, let agents act`);
  }
  if (role === 'admin') {
    print(`  ${c.bold}step${c.reset} [N]            — Advance N rounds`);
    print(`  ${c.bold}inject${c.reset} <text>       — Inject a post`);
    print(`  ${c.bold}news${c.reset} <headline>     — Broadcast breaking news`);
    print(`  ${c.bold}interview${c.reset} <id> <q>  — Interview an agent`);
    print(`  ${c.bold}agents${c.reset}              — List agents`);
    print(`  ${c.bold}posts${c.reset}               — List all posts`);
  }
  print(`  ${c.bold}status${c.reset}              — World overview`);
  print(`  ${c.bold}view${c.reset} <post_id>      — View post + comments`);
  print(`  ${c.bold}who${c.reset} <user_id>       — View user profile`);
  print(`  ${c.bold}help${c.reset}                — Show this help`);
  print(`  ${c.bold}quit${c.reset}                — Exit`);
  print('');
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  print(`\n${c.bold}${c.magenta}🌍 WorldMind — ${role === 'admin' ? 'God Mode' : 'Player Mode'}${c.reset}`);
  print(`${'═'.repeat(50)}`);

  // Build world settings from preset
  const worldSettings = createWorldSettings(selectedPreset, {
    agentCount,
    llm: {
      apiKey: process.env.WORLDMIND_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
      baseUrl: process.env.WORLDMIND_LLM_BASE_URL ?? process.env.OPENAI_API_BASE ?? '',
      model: process.env.WORLDMIND_LLM_MODEL ?? 'gpt-4o-mini',
    },
    player: role === 'player' ? {
      username: playerName,
      displayName: playerName,
      bio: 'A real human exploring this simulation.',
    } : undefined,
  });

  // Generate profile CSV from world settings
  const profileDir = join(process.cwd(), 'data/social');
  mkdirSync(profileDir, { recursive: true });
  const profilePath = join(profileDir, `world_${Date.now()}.csv`);
  writeFileSync(profilePath, generateProfileCSV(worldSettings), 'utf-8');

  const engine = new WorldEngine({
    platform: worldSettings.platform,
    agentCount: worldSettings.agentCount,
    profilePath,
    llm: worldSettings.llm,
    player: worldSettings.player,
  });

  info(`World: ${worldSettings.name} (${worldSettings.language})`);
  info(`Agents: ${agentCount}`);
  info('Initializing world...');

  try {
    await engine.init();
  } catch (e) {
    error(`Failed to initialize: ${(e as Error).message}`);
    process.exit(1);
  }

  const state = engine.getWorldState();
  success(`World ready! ${state.totalAgents} agents online.`);
  if (state.player) success(`You are agent #${state.player.id}`);
  print('');
  showHelp();

  // Interactive loop
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: role === 'admin'
      ? `${c.yellow}god>${c.reset} `
      : `${c.green}you>${c.reset} `,
  });

  rl.prompt();

  rl.on('line', async (input) => {
    const line = input.trim();
    if (!line) { rl.prompt(); return; }

    const [cmd, ...rest] = line.split(/\s+/);
    const text = rest.join(' ');

    try {
      switch (cmd) {
        case 'post': {
          if (!text) { warn('Usage: post <text>'); break; }
          info('Posting...');
          const s = await engine.playerAct({ type: 'post', content: text });
          success('Posted!');
          showNotifs(s.notifications);
          break;
        }
        case 'comment': {
          const postId = parseInt(rest[0] ?? '');
          const commentText = rest.slice(1).join(' ');
          if (!postId || !commentText) { warn('Usage: comment <post_id> <text>'); break; }
          info('Commenting...');
          const s = await engine.playerAct({ type: 'comment', postId, content: commentText });
          success('Commented!');
          showNotifs(s.notifications);
          break;
        }
        case 'like': {
          const postId = parseInt(text);
          if (!postId) { warn('Usage: like <post_id>'); break; }
          const s = await engine.playerAct({ type: 'like', postId });
          success('Liked!');
          showNotifs(s.notifications);
          break;
        }
        case 'follow': {
          const userId = parseInt(text);
          if (!userId) { warn('Usage: follow <user_id>'); break; }
          const s = await engine.playerAct({ type: 'follow', userId });
          success(`Followed agent #${userId}`);
          showNotifs(s.notifications);
          break;
        }
        case 'feed': {
          const posts = engine.getFeed(10);
          header('📰 Your Feed');
          if (posts.length === 0) { info('Nothing yet. Try posting or waiting.'); break; }
          for (const p of posts) renderPost(p);
          break;
        }
        case 'notifs':
        case 'notifications': {
          const s = engine.getWorldState();
          showNotifs(s.notifications);
          break;
        }
        case 'me': {
          const s = engine.getWorldState();
          if (s.player) {
            header('👤 Your Profile');
            print(`  Posts: ${s.player.posts}`);
            print(`  Followers: ${s.player.followers}`);
            print(`  Following: ${s.player.following}`);
          } else {
            warn('No player in admin mode. Use "who <id>" to view agents.');
          }
          print('');
          break;
        }
        case 'wait': {
          info('Skipping turn... agents are acting...');
          const s = role === 'admin'
            ? await engine.adminAct({ type: 'wait' })
            : await engine.playerAct({ type: 'wait' });
          success(`Round ${s.round} complete.`);
          showNotifs(s.notifications);
          break;
        }
        case 'step': {
          const n = parseInt(text) || 1;
          info(`Advancing ${n} round(s)...`);
          const s = await engine.adminAct({ type: 'step', rounds: n });
          success(`Round ${s.round}. ${s.totalPosts} posts, ${s.totalComments} comments.`);
          break;
        }
        case 'inject': {
          if (!text) { warn('Usage: inject <text>'); break; }
          info('Injecting post...');
          const s = await engine.adminAct({ type: 'inject_event', content: text });
          success('Injected!');
          break;
        }
        case 'news': {
          if (!text) { warn('Usage: news <headline>'); break; }
          info('Broadcasting news...');
          const s = await engine.adminAct({ type: 'inject_news', headline: text });
          success('News broadcast! Agents are reacting...');
          break;
        }
        case 'interview': {
          const agentId = parseInt(rest[0] ?? '');
          const question = rest.slice(1).join(' ');
          if (!agentId || !question) { warn('Usage: interview <agent_id> <question>'); break; }
          info(`Interviewing agent #${agentId}...`);
          await engine.adminAct({ type: 'interview', agentId, question });
          break;
        }
        case 'agents': {
          const agents = engine.getAgents(20);
          header('🤖 Agents');
          for (const a of agents) {
            const tag = a.isPlayer ? ` ${c.green}(you)${c.reset}` : '';
            print(`  #${a.id} @${a.username}${tag} — ${a.bio.slice(0, 60)}`);
            print(`  ${c.dim}${a.followers} followers, ${a.following} following${c.reset}`);
          }
          print('');
          break;
        }
        case 'posts': {
          const posts = engine.getFeed(20);
          header('📝 All Posts');
          for (const p of posts) renderPost(p);
          break;
        }
        case 'view': {
          const postId = parseInt(text);
          if (!postId) { warn('Usage: view <post_id>'); break; }
          const result = engine.getPost(postId);
          if (!result) { warn('Post not found.'); break; }
          header(`📄 Post #${postId}`);
          renderPost(result.post);
          if (result.comments.length > 0) {
            print(`  ${c.dim}── Comments ──${c.reset}`);
            for (const cm of result.comments) {
              print(`  ${c.bold}@${cm.authorName}${c.reset}: ${cm.content}`);
            }
          }
          print('');
          break;
        }
        case 'who': {
          const userId = parseInt(text);
          if (!userId) { warn('Usage: who <user_id>'); break; }
          const agent = engine.getAgent(userId);
          if (!agent) { warn('User not found.'); break; }
          header(`👤 @${agent.username}`);
          print(`  ${agent.displayName}`);
          print(`  ${agent.bio}`);
          print(`  ${c.dim}${agent.followers} followers, ${agent.following} following${c.reset}`);
          print('');
          break;
        }
        case 'status': {
          const s = engine.getWorldState();
          header('🌍 World Status');
          print(`  Round: ${s.round}`);
          print(`  Agents: ${s.totalAgents}`);
          print(`  Posts: ${s.totalPosts}`);
          print(`  Comments: ${s.totalComments}`);
          print(`  Likes: ${s.totalLikes}`);
          print(`  Follows: ${s.totalFollows}`);
          if (s.player) {
            print(`  ${c.green}You: ${s.player.posts} posts, ${s.player.followers} followers${c.reset}`);
          }
          print('');
          break;
        }
        case 'help':
          showHelp();
          break;
        case 'quit':
        case 'exit':
          info('Shutting down...');
          await engine.shutdown();
          process.exit(0);
          break;
        default:
          warn(`Unknown command: ${cmd}. Type "help" for commands.`);
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

function showNotifs(notifs: any[]) {
  if (notifs.length === 0) return;
  print(`  ${c.cyan}🔔 Notifications:${c.reset}`);
  for (const n of notifs.slice(0, 5)) {
    const icon = n.type === 'like' ? '❤️' : n.type === 'follow' ? '👤' : n.type === 'comment' ? '💬' : '🔄';
    print(`    ${icon} @${n.fromAgent} ${n.content}`);
  }
  if (notifs.length > 5) print(`    ${c.dim}...and ${notifs.length - 5} more${c.reset}`);
  print('');
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

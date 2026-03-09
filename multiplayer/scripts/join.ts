#!/usr/bin/env tsx
/**
 * Join a WorldMind Multiplayer Server as a player
 *
 * Usage:
 *   npx tsx multiplayer/scripts/join.ts --server ws://localhost:3000 --name myles
 */

import { WorldClient } from '../src/client.js';
import { createInterface } from 'readline';

const args = process.argv.slice(2);
const get = (f: string) => args.find((_, i) => args[i - 1] === `--${f}`);

const serverUrl = get('server') ?? 'ws://localhost:3000';
const playerName = get('name') ?? `player-${Date.now() % 10000}`;

const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', cyan: '\x1b[36m', magenta: '\x1b[35m', yellow: '\x1b[33m' };
const print = (m: string) => process.stdout.write(m + '\n');

async function main() {
  print(`\n${c.magenta}🎮 WorldMind Player${c.reset}`);
  print(`  Connecting to ${serverUrl}...`);

  const client = new WorldClient({ url: serverUrl, autoReconnect: true });

  client.onRoundStart = (round, feed, notifications) => {
    print(`\n${c.cyan}─── Round ${round} ───${c.reset}`);
    if (feed.length > 0) {
      print(`${c.bold}📰 Feed:${c.reset}`);
      for (const f of feed) {
        print(`  [#${f.postId}] @${f.authorName}: ${f.content.slice(0, 80)}`);
        print(`  ${c.dim}❤️ ${f.likes}  💬 ${f.comments}${c.reset}`);
      }
    }
    if (notifications.length > 0) {
      print(`${c.bold}🔔 Notifications:${c.reset}`);
      for (const n of notifications) print(`  ${n.fromAgent} ${n.type}: ${n.content}`);
    }
    print(`${c.dim}Enter action (post/comment/like/feed/state/quit):${c.reset}`);
  };

  client.onRoundEnd = (round, state) => {
    print(`${c.dim}Round ${round} end — Posts: ${state.totalPosts} Comments: ${state.totalComments}${c.reset}`);
  };

  client.onEvent = (event, data) => {
    print(`${c.yellow}[event] ${event}: ${JSON.stringify(data)}${c.reset}`);
  };

  await client.connect();
  const { playerId, worldContext, npcs } = await client.join(playerName);
  print(`${c.green}✓ Joined as #${playerId} (@${playerName})${c.reset}`);
  print(`${c.dim}World: ${worldContext.slice(0, 100)}...${c.reset}`);
  print(`${c.dim}NPCs: ${npcs.map(n => '@' + n.username).join(', ')}${c.reset}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${c.magenta}>${c.reset} ` });
  rl.prompt();

  rl.on('line', async (input) => {
    const line = input.trim();
    if (!line) { rl.prompt(); return; }
    const [cmd, ...rest] = line.split(/\s+/);
    const text = rest.join(' ');

    try {
      switch (cmd) {
        case 'post':
          if (!text) { print('Usage: post <text>'); break; }
          await client.act({ action: 'post', content: text });
          print(`${c.green}✓ Posted${c.reset}`);
          break;
        case 'comment':
          // comment <postId> <text>
          const postId = parseInt(rest[0] ?? '');
          const commentText = rest.slice(1).join(' ');
          if (!postId || !commentText) { print('Usage: comment <postId> <text>'); break; }
          await client.act({ action: 'comment', content: commentText, targetPostId: postId });
          print(`${c.green}✓ Commented on #${postId}${c.reset}`);
          break;
        case 'like':
          const likeId = parseInt(text);
          if (!likeId) { print('Usage: like <postId>'); break; }
          await client.act({ action: 'like', targetPostId: likeId });
          print(`${c.green}✓ Liked #${likeId}${c.reset}`);
          break;
        case 'feed': {
          const feed = await client.getFeed();
          if (!feed.length) { print('  Empty feed.'); break; }
          for (const f of feed) {
            print(`  ${c.bold}#${f.postId}${c.reset} @${f.authorName}: ${f.content}`);
            print(`  ${c.dim}❤️ ${f.likes}  💬 ${f.comments}${c.reset}`);
          }
          break;
        }
        case 'state': {
          const state = await client.getState();
          print(`  Round: ${state.round} | Posts: ${state.totalPosts} | Comments: ${state.totalComments}`);
          print(`  Players: ${state.totalPlayers} | NPCs: ${state.totalAgents}`);
          break;
        }
        case 'agents': {
          const agents = await client.getAgents();
          for (const a of agents) {
            const tag = a.type === 'player' ? c.green + ' (player)' + c.reset : '';
            print(`  @${a.username}${tag} — ${a.personality?.slice(0, 50) ?? ''}`);
          }
          break;
        }
        case 'quit': case 'exit':
          client.leave();
          process.exit(0);
        default:
          print('Commands: post, comment, like, feed, state, agents, quit');
      }
    } catch (e) { print(`Error: ${(e as Error).message}`); }
    rl.prompt();
  });
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

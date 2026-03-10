#!/usr/bin/env tsx
/**
 * AI Player — Autonomous agent that joins a WorldMind multiplayer server,
 * reads the feed, and makes decisions using LLM.
 *
 * Usage:
 *   npx tsx multiplayer/scripts/ai-player.ts --server ws://localhost:3000 --name "alice" --personality "好奇心旺盛的独立开发者"
 *   npx tsx multiplayer/scripts/ai-player.ts --server ws://localhost:3000 --name "bob" --personality "犀利的技术评论家" --rounds 10
 */

import { WorldClient } from '../src/client.js';
import { LLMClient } from '../../src/llm/client.js';
import type { FeedItem, Notification } from '../src/types.js';
import { readFileSync } from 'fs';
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

const serverUrl = get('server') ?? 'ws://localhost:3000';
const playerName = get('name') ?? `ai-${Date.now() % 10000}`;
const personality = get('personality') ?? '一个友善的技术爱好者，喜欢深入讨论';
const maxRounds = parseInt(get('rounds') ?? '0'); // 0 = infinite

const print = (m: string) => process.stdout.write(m + '\n');

// ─── LLM ────────────────────────────────────────────────────────
const llm = new LLMClient({
  apiKey: process.env.WORLDMIND_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
  baseURL: process.env.WORLDMIND_LLM_BASE_URL ?? process.env.OPENAI_API_BASE ?? 'https://api.openai.com/v1',
  model: process.env.WORLDMIND_LLM_MODEL ?? 'gpt-4o-mini',
});

// ─── AI Decision ────────────────────────────────────────────────

interface AIDecision {
  action: 'post' | 'comment' | 'like' | 'repost' | 'quote' | 'follow'
    | 'create_group' | 'join_group' | 'send_to_group' | 'do_nothing';
  content?: string;
  targetPostId?: number;
  targetUserId?: number;
  groupId?: number;
  groupName?: string;
  reasoning: string;
}

const memory: string[] = [];

async function decide(round: number, feed: FeedItem[], notifications: Notification[]): Promise<AIDecision> {
  const systemPrompt = `你是社交平台上的用户 @${playerName}。
性格: ${personality}

规则:
- 你看到 feed 和通知后，决定做一件事
- 可选: post(发帖), comment(评论), like(点赞), repost(转发), quote(引用转发并评论), follow(关注用户), create_group(建群), join_group(加群), send_to_group(群聊发消息), do_nothing(潜水)
- 发言要简洁自然（像真人发社交媒体一样，不超过100字）
- 不要每轮都发帖，多回复/转发/点赞别人的内容
- 如果有人回复了你或提到了你关心的话题，优先回复
- 如果 feed 里没什么有趣的内容，可以 do_nothing
- 用 repost 无评论转发好内容，用 quote 转发并加自己的看法
- 觉得某人有意思就 follow 他

- 群聊用于私下交流，不是每轮都用。create_group需要groupName，join_group/send_to_group需要groupId

输出 JSON:
{"action":"...","content":"...","targetPostId":123,"targetUserId":456,"groupId":1,"groupName":"密谋群","reasoning":"..."}`;

  const feedStr = feed.length > 0
    ? feed.map(f => `[#${f.postId}] @${f.authorName}: ${f.content.slice(0, 120)} (❤️${f.likes} 💬${f.comments})`).join('\n')
    : '(空)';

  const notiStr = notifications.length > 0
    ? notifications.map(n => `${n.fromAgent} ${n.type}: ${n.content}`).join('\n')
    : '(无)';

  const memStr = memory.length > 0
    ? `你之前的行为:\n${memory.slice(-5).join('\n')}`
    : '';

  const userPrompt = `Round ${round}

通知:\n${notiStr}

Feed:\n${feedStr}

${memStr}

请决定你的行动:`;

  const response = await llm.complete(systemPrompt, userPrompt, {
    temperature: 0.85,
    maxTokens: 500,
  });

  // Parse
  let cleaned = response.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const d = JSON.parse(cleaned);
    return {
      action: d.action ?? 'do_nothing',
      content: d.content,
      targetPostId: d.targetPostId,
      reasoning: d.reasoning ?? '',
    };
  } catch {
    // Try to extract JSON from text
    const match = cleaned.match(/\{[^{}]*"action"[^{}]*\}/);
    if (match) {
      try {
        const d = JSON.parse(match[0]);
        return { action: d.action ?? 'do_nothing', content: d.content, targetPostId: d.targetPostId, reasoning: d.reasoning ?? '' };
      } catch {}
    }
    return { action: 'do_nothing', reasoning: 'parse_failure' };
  }
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  print(`\n🤖 AI Player: @${playerName}`);
  print(`   性格: ${personality}`);
  print(`   Server: ${serverUrl}`);
  print('─'.repeat(40));

  const client = new WorldClient({ url: serverUrl, autoReconnect: true });

  let roundCount = 0;

  client.onRoundStart = async (round, feed, notifications) => {
    roundCount++;
    print(`\n── Round ${round} ──`);
    print(`  Feed: ${feed.length} items | Notifs: ${notifications.length}`);

    if (maxRounds > 0 && roundCount > maxRounds) {
      print('  达到最大轮数，退出。');
      client.leave();
      process.exit(0);
    }

    try {
      const decision = await decide(round, feed, notifications);
      const icons: Record<string, string> = {
        post: '📝', comment: '💬', like: '❤️', repost: '🔁', quote: '💬🔁', follow: '👤',
        create_group: '🏠', join_group: '🚪', send_to_group: '📨', do_nothing: '😴',
      };
      const icon = icons[decision.action] ?? '❓';
      print(`  ${icon} ${decision.action}: ${decision.content?.slice(0, 80) ?? '(lurk)'}`);
      if (decision.reasoning) print(`     (${decision.reasoning})`);

      if (decision.action !== 'do_nothing') {
        await client.act({
          action: decision.action,
          content: decision.content,
          targetPostId: decision.targetPostId,
          targetUserId: decision.targetUserId,
          groupId: decision.groupId,
          groupName: decision.groupName,
        });
        memory.push(`Round ${round}: ${decision.action} — ${decision.content?.slice(0, 60) ?? ''}`);
        print(`  ✓ Action submitted`);
      }
    } catch (e) {
      print(`  ✗ Error: ${(e as Error).message}`);
    }
  };

  client.onRoundEnd = (round, state) => {
    print(`  [Round ${round} end] Posts: ${state.totalPosts} Comments: ${state.totalComments} Likes: ${state.totalLikes}`);
  };

  client.onEvent = (event, data) => {
    if (event === 'player_joined' || event === 'player_left') {
      print(`  [${event}] ${JSON.stringify(data)}`);
    }
  };

  await client.connect();
  const { playerId, worldContext, npcs } = await client.join(playerName, {
    role: 'ai-player',
    personality,
  });
  print(`✓ Joined as #${playerId} (@${playerName})`);
  print(`  NPCs: ${npcs.map(n => '@' + n.username).join(', ')}`);
  print('  等待第一个 round...\n');

  // Keep alive
  process.on('SIGINT', () => {
    print('\n退出...');
    client.leave();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    client.leave();
    process.exit(0);
  });
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

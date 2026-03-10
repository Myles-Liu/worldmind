/**
 * Post-simulation interview & analysis tool.
 * 
 * Reads a completed simulation's DB + memory, interviews each agent via LLM,
 * and generates a narrative analysis report.
 * 
 * Usage:
 *   npx tsx multiplayer/scripts/interview.ts --run data/social/2026-03-10-10-47-33
 */
import { join } from 'path';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import Database from 'better-sqlite3';
import { LLMClient } from '../../src/llm/client.js';

// ─── Args ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const runDirArg = args[args.indexOf('--run') + 1] ?? '';

if (!runDirArg) {
  console.error('Usage: npx tsx multiplayer/scripts/interview.ts --run <run-dir>');
  process.exit(1);
}

const runDir = runDirArg.startsWith('/') ? runDirArg : join(process.cwd(), runDirArg);
const dbPath = join(runDir, 'world.db');
const memoryDir = join(runDir, 'memory');
const memoryPath = join(memoryDir, 'memory.json');
const outputDir = join(runDir, 'report');

if (!existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}

// ─── Load data ───────────────────────────────────────────────

const db = new Database(dbPath, { readonly: true });

// Users
const users: Array<{ user_id: number; name: string; bio: string }> = db
  .prepare("SELECT user_id, COALESCE(NULLIF(user_name, ''), name, 'agent_' || user_id) as name, bio FROM user")
  .all() as any;

// Posts with author
const posts: Array<{ post_id: number; name: string; content: string; num_likes: number }> = db
  .prepare(`
    SELECT p.post_id, COALESCE(NULLIF(u.user_name, ''), u.name) as name, p.content, p.num_likes
    FROM post p JOIN user u ON p.user_id = u.user_id
    ORDER BY p.post_id
  `)
  .all() as any;

// Comments with author
const comments: Array<{ post_id: number; name: string; content: string }> = db
  .prepare(`
    SELECT c.post_id, COALESCE(NULLIF(u.user_name, ''), u.name) as name, c.content
    FROM comment c JOIN user u ON c.user_id = u.user_id
    ORDER BY c.created_at
  `)
  .all() as any;

// Stats
const stats = {
  posts: posts.length,
  comments: comments.length,
  likes: (db.prepare('SELECT COUNT(*) as n FROM "like"').get() as any).n,
  follows: (db.prepare('SELECT COUNT(*) as n FROM follow').get() as any).n,
  users: users.length,
};

// Memory
let memoryData: Record<string, { agentName: string; compressedSummary?: string; entries: Array<{ content: string }> }> = {};
if (existsSync(memoryPath)) {
  memoryData = JSON.parse(readFileSync(memoryPath, 'utf-8'));
}

console.log(`\n📊 Simulation Stats: ${stats.posts} posts, ${stats.comments} comments, ${stats.likes} likes, ${stats.follows} follows`);
console.log(`👥 Agents: ${users.map(u => u.name).join(', ')}\n`);

// ─── Build simulation transcript ────────────────────────────

function buildTranscript(): string {
  const lines: string[] = ['# Simulation Transcript\n'];
  for (const post of posts) {
    lines.push(`## [Post #${post.post_id}] @${post.name} (❤️${post.num_likes})`);
    lines.push(post.content);
    const postComments = comments.filter(c => c.post_id === post.post_id);
    for (const c of postComments) {
      lines.push(`  └─ @${c.name}: ${c.content}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const transcript = buildTranscript();

// ─── LLM setup ──────────────────────────────────────────────

const llm = new LLMClient({
  apiKey: process.env.WORLDMIND_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
  baseURL: process.env.WORLDMIND_LLM_BASE_URL ?? process.env.OPENAI_API_BASE ?? 'https://api.openai.com/v1',
  model: process.env.WORLDMIND_LLM_MODEL ?? 'gpt-4o-mini',
});

// ─── Interview each agent ───────────────────────────────────

interface InterviewResult {
  agentId: number;
  name: string;
  answers: Array<{ question: string; answer: string }>;
}

const INTERVIEW_QUESTIONS = [
  '回顾整个模拟过程，你觉得最重要的事件是什么？为什么？',
  '你对其他角色分别有什么看法？谁是你的盟友？谁是你的对手？',
  '如果可以重来一次，你会做什么不同的选择？',
  '你在模拟中最自豪/最后悔的一个行动是什么？',
  '用一句话总结你在这个世界中的角色定位。',
];

async function interviewAgent(user: { user_id: number; name: string; bio: string }): Promise<InterviewResult> {
  const memory = memoryData[String(user.user_id)];
  const memorySummary = memory?.compressedSummary ?? memory?.entries?.map(e => e.content).join('\n') ?? '(no memory)';

  const systemPrompt = `你是 @${user.name}。
个人简介: ${user.bio}

你的记忆:
${memorySummary}

平台上发生了这些事:
${transcript.slice(0, 3000)}

现在有人要采访你。请以你的角色身份回答，保持性格一致，回答要真诚、有洞察力。每个回答不超过150字。`;

  const answers: Array<{ question: string; answer: string }> = [];

  for (const question of INTERVIEW_QUESTIONS) {
    try {
      const response = await llm.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question },
      ]);
      answers.push({ question, answer: response.trim() });
      console.log(`  ✓ @${user.name}: "${question.slice(0, 30)}..."`);
    } catch (e) {
      answers.push({ question, answer: `(interview failed: ${(e as Error).message})` });
    }
  }

  return { agentId: user.user_id, name: user.name, answers };
}

// ─── Generate analysis report ───────────────────────────────

async function generateReport(interviews: InterviewResult[]): Promise<string> {
  const interviewText = interviews.map(i => {
    const qa = i.answers.map(a => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n');
    return `## @${i.name}\n${qa}`;
  }).join('\n\n---\n\n');

  const prompt = `你是一个社会模拟分析师。以下是一次多 Agent 社交模拟的数据。

# 统计
- ${stats.posts} 帖子, ${stats.comments} 评论, ${stats.likes} 点赞, ${stats.follows} 关注
- ${stats.users} 个角色

# 对话记录
${transcript.slice(0, 4000)}

# 采访记录
${interviewText}

请生成一份详细的分析报告（中文），包含：

1. **模拟概述** — 发生了什么？主要剧情线是什么？
2. **角色分析** — 每个角色的行为模式、性格表现、关键时刻
3. **社交网络** — 谁和谁互动最多？形成了哪些阵营/对立？
4. **关键事件时间线** — 按时间顺序列出转折点
5. **信息传播分析** — 重要信息如何在角色间传播？
6. **洞察与结论** — 这次模拟揭示了哪些有趣的社交动力学现象？

格式用 Markdown。`;

  const report = await llm.chat([
    { role: 'system', content: '你是专业的社会模拟分析师。擅长分析多 Agent 社交系统的行为模式。' },
    { role: 'user', content: prompt },
  ]);

  return report;
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  console.log('🎤 Starting interviews...\n');

  const interviews: InterviewResult[] = [];
  for (const user of users) {
    console.log(`\n  Interviewing @${user.name}...`);
    const result = await interviewAgent(user);
    interviews.push(result);
  }

  console.log('\n\n📝 Generating analysis report...\n');
  const report = await generateReport(interviews);

  // Save outputs
  mkdirSync(outputDir, { recursive: true });

  // Save interviews
  const interviewMd = interviews.map(i => {
    const qa = i.answers.map(a => `**Q: ${a.question}**\n\n${a.answer}`).join('\n\n');
    return `## @${i.name}\n\n${qa}`;
  }).join('\n\n---\n\n');
  writeFileSync(join(outputDir, 'interviews.md'), `# Agent Interviews\n\n${interviewMd}`, 'utf-8');

  // Save transcript
  writeFileSync(join(outputDir, 'transcript.md'), transcript, 'utf-8');

  // Save report
  writeFileSync(join(outputDir, 'report.md'), report, 'utf-8');

  // Save stats
  writeFileSync(join(outputDir, 'stats.json'), JSON.stringify({ stats, users: users.map(u => u.name) }, null, 2), 'utf-8');

  console.log(`\n✅ Report saved to ${outputDir}/`);
  console.log(`   - report.md (分析报告)`);
  console.log(`   - interviews.md (采访记录)`);
  console.log(`   - transcript.md (对话记录)`);
  console.log(`   - stats.json (统计数据)`);

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });

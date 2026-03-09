#!/usr/bin/env tsx
/**
 * Predict a specific repo's trajectory.
 *
 * Usage:
 *   npx tsx scripts/predict-repo.ts Myles-Liu/worldmind
 *   npx tsx scripts/predict-repo.ts owner/repo [--days 30]
 */

import { execSync } from 'node:child_process';
import { TrendAgent } from '../src/agents/trend.js';
import { PredictAgent } from '../src/agents/predict.js';
import { ChallengeAgent } from '../src/agents/challenge.js';
import { KnowledgeBase } from '../src/memory/knowledge-base.js';
import { SharedContextBus } from '../src/context/shared-bus.js';
import { createEvent } from '../src/types/event.js';

const repoArg = process.argv[2] ?? '';
if (!repoArg.includes('/')) {
  console.error('Usage: npx tsx scripts/predict-repo.ts owner/repo');
  process.exit(1);
}

const GITHUB_TOKEN = process.env['GITHUB_TOKEN'] ?? '';

function ghApi(endpoint: string): any {
  const auth = GITHUB_TOKEN ? `-H "Authorization: Bearer ${GITHUB_TOKEN}"` : '';
  try {
    return JSON.parse(execSync(
      `curl -sf ${auth} -H "Accept: application/vnd.github.v3+json" "https://api.github.com${endpoint}" 2>/dev/null`,
      { timeout: 15000, encoding: 'utf-8' }
    ));
  } catch { return null; }
}

async function main() {
  const [owner, repo] = repoArg.split('/');
  console.log(`\n🔮 WorldMind Prediction: ${repoArg}\n`);

  // Fetch repo metadata
  const meta = ghApi(`/repos/${repoArg}`);
  if (!meta) { console.error('Could not fetch repo.'); process.exit(1); }

  console.log(`  Stars: ${meta.stargazers_count}`);
  console.log(`  Forks: ${meta.forks_count}`);
  console.log(`  Language: ${meta.language}`);
  console.log(`  Created: ${meta.created_at}`);
  console.log(`  Description: ${meta.description}`);

  // Fetch recent commits
  const commits = ghApi(`/repos/${repoArg}/commits?per_page=10`) ?? [];
  const recentCommits = commits.length;
  const uniqueAuthors = new Set(commits.map((c: any) => c.commit?.author?.name)).size;

  // Check README
  const readme = ghApi(`/repos/${repoArg}/readme`);
  const readmeContent = readme?.content
    ? Buffer.from(readme.content, 'base64').toString('utf-8').slice(0, 1000)
    : '';

  // Estimate stars/day (if repo is older than 1 day)
  const ageMs = Date.now() - new Date(meta.created_at).getTime();
  const ageDays = Math.max(1, ageMs / 86400000);
  const starsPerDay = Math.round(meta.stargazers_count / ageDays * 10) / 10;

  console.log(`  Age: ${Math.round(ageDays)} days`);
  console.log(`  Stars/day: ${starsPerDay}`);
  console.log(`  Recent commits: ${recentCommits} (${uniqueAuthors} authors)`);
  console.log();

  // Build event
  const event = createEvent({
    type: 'new_repo_discovered',
    source: 'collector:backtest',
    entities: [`repo:${repoArg}`],
    data: {
      metadata: {
        fullName: repoArg,
        owner,
        name: repo,
        stars: meta.stargazers_count,
        description: meta.description ?? '',
        language: meta.language,
        topics: meta.topics ?? [],
        forks: meta.forks_count,
        isFork: meta.fork,
      },
      starsPerDay,
      velocityTier: starsPerDay > 100 ? 'viral' : starsPerDay > 20 ? 'fast' : starsPerDay > 5 ? 'moderate' : 'slow',
      recentCommitCount: recentCommits,
      recentUniqueAuthors: uniqueAuthors,
      readme: readmeContent,
      daysSinceCreation: Math.round(ageDays),
    },
    importance: 0.9,
  });

  // Run pipeline
  const kb = new KnowledgeBase();
  await kb.load();
  const bus = new SharedContextBus();
  bus.startCycle(1);

  console.log('═══ Agent Analysis ═══\n');

  // Trend
  const start1 = Date.now();
  const trend = new TrendAgent();
  trend.setKnowledgeBase(kb);
  trend.setSharedBus(bus);
  const trendOut = await trend.analyze([event]);
  bus.publish('trend', trendOut);
  console.log(`  🔍 Trend Agent (${Math.round((Date.now() - start1) / 1000)}s)`);
  for (const o of trendOut) console.log(`     ${o.summary}`);
  if (trendOut.length === 0) console.log(`     No significant trend signal detected.`);

  // Predict
  const start2 = Date.now();
  const predict = new PredictAgent();
  predict.setKnowledgeBase(kb);
  predict.setSharedBus(bus);
  const predictions = await predict.analyze([event]);
  bus.publish('predict', predictions);
  console.log(`  🎯 Predict Agent (${Math.round((Date.now() - start2) / 1000)}s)`);
  for (const o of predictions) console.log(`     ${o.summary}`);
  if (predictions.length === 0) console.log(`     No prediction generated.`);

  // Challenge
  const start3 = Date.now();
  const challenge = new ChallengeAgent();
  challenge.setKnowledgeBase(kb);
  challenge.setSharedBus(bus);
  const challenges = await challenge.analyze([event]);
  bus.publish('challenge', challenges);
  console.log(`  ⚔️  Challenge Agent (${Math.round((Date.now() - start3) / 1000)}s)`);
  for (const o of challenges) console.log(`     ${o.summary}`);

  // Round 2
  if (challenges.length > 0 && predictions.length > 0) {
    const start4 = Date.now();
    const final = await predict.revise(predictions, challenges);
    console.log(`  🔄 Round 2 Revision (${Math.round((Date.now() - start4) / 1000)}s)`);
    for (const o of final) console.log(`     ${o.summary}`);

    console.log(`\n═══ Final Verdict ═══\n`);
    for (const o of final) {
      const d = o.data;
      console.log(`  ${repoArg}:`);
      console.log(`    Original prediction: ${d['originalValue']} ${d['metric'] ?? 'stars'} in ${d['timeframeDays']}d`);
      console.log(`    After debate:        ${d['revisedValue']} ${d['metric'] ?? 'stars'} in ${d['timeframeDays']}d`);
      console.log(`    Confidence:          ${Math.round(o.confidence * 100)}%`);
      console.log(`    Accepted challenges: ${(d['acceptedChallenges'] as string[] ?? []).join('; ')}`);
      console.log(`    Rejected challenges: ${(d['rejectedChallenges'] as string[] ?? []).join('; ')}`);
      console.log(`    Reasoning:           ${o.reasoning}`);
    }
  } else {
    console.log(`\n═══ Final Verdict ═══\n`);
    if (predictions.length > 0) {
      for (const o of predictions) {
        console.log(`  ${repoArg}: ${o.data['predictedValue']} ${o.data['metric'] ?? 'stars'} in ${o.data['timeframeDays']}d (${Math.round(o.confidence * 100)}%)`);
        console.log(`  Reasoning: ${o.reasoning}`);
      }
    } else {
      console.log(`  No prediction produced — insufficient signal.`);
    }
  }

  console.log();
}

main().catch(console.error);

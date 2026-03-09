#!/usr/bin/env tsx
/**
 * WorldMind Discovery + Analysis Pipeline
 * 
 * End-to-end: discover candidate repos → Agent analysis → predictions
 * 
 * Usage:
 *   npx tsx scripts/run-discovery-analysis.ts
 *   npx tsx scripts/run-discovery-analysis.ts --top 10
 */

import { promises as fs } from 'node:fs';
import { DiscoveryPipeline, type RepoCandidate } from '../src/collectors/discovery.js';
import { TrendAgent } from '../src/agents/trend.js';
import { NetworkAgent } from '../src/agents/network.js';
import { TechAgent } from '../src/agents/tech.js';
import { PredictAgent } from '../src/agents/predict.js';
import { ChallengeAgent } from '../src/agents/challenge.js';
import { KnowledgeBase } from '../src/memory/knowledge-base.js';
import { SharedContextBus } from '../src/context/shared-bus.js';
import { PredictionStore } from '../src/memory/prediction-store.js';
import { createEvent, type WorldEvent } from '../src/types/event.js';
import { makeEntityId } from '../src/types/entity.js';
import type { AgentOutput } from '../src/types/agent.js';
import type { BaseAgent } from '../src/agents/base-agent.js';

// ─── Parse args ─────────────────────────────────────────────────

const args = process.argv.slice(2);
const topN = parseInt(args.find((_, i) => args[i - 1] === '--top') ?? '10', 10);

// ─── Helpers ────────────────────────────────────────────────────

function configureAgent(agent: BaseAgent, kb: KnowledgeBase, bus: SharedContextBus): void {
  agent.setKnowledgeBase(kb);
  agent.setSharedBus(bus);
}

/**
 * Convert a RepoCandidate into WorldEvents that agents can process.
 */
function candidateToEvents(candidate: RepoCandidate): WorldEvent[] {
  const events: WorldEvent[] = [];

  // Primary event: new repo discovered (with all enrichment data)
  if (candidate.signals.newRepo) {
    const nr = candidate.signals.newRepo;
    events.push(createEvent({
      type: 'new_repo_discovered',
      source: 'collector:new-repos',
      entities: [candidate.entityId],
      data: {
        metadata: {
          fullName: candidate.repoFullName,
          owner: candidate.repoFullName.split('/')[0],
          name: candidate.repoFullName.split('/')[1],
          description: nr.description,
          language: nr.language,
          topics: nr.topics,
          stars: nr.stars,
          forks: 0,
          openIssues: 0,
          watchers: 0,
          license: null,
          createdAt: '',
          updatedAt: '',
          homepage: null,
          isArchived: false,
          isFork: false,
          defaultBranch: 'main',
        },
        starsPerDay: nr.starsPerDay,
        daysSinceCreation: nr.daysSinceCreation,
        velocityTier: nr.velocityTier,
        readme: nr.readme,
        ownerFollowers: nr.ownerFollowers,
        ownerType: nr.ownerType,
        recentCommitCount: nr.recentCommitCount,
        recentUniqueAuthors: nr.recentUniqueAuthors,
        languages: nr.languages,
      },
      importance: candidate.discoveryScore,
    }));
  }

  // HN event
  if (candidate.signals.hn) {
    const hn = candidate.signals.hn;
    events.push(createEvent({
      type: 'hn_mention',
      source: 'collector:hn',
      entities: [candidate.entityId],
      data: {
        repoFullName: candidate.repoFullName,
        hnScore: hn.score,
        hnComments: hn.comments,
        hnMentionCount: hn.mentionCount,
        hasShowHN: hn.hasShowHN,
        hnTitle: hn.title,
        hnPostTime: hn.postTime,
      },
      importance: candidate.discoveryScore,
    }));
  }

  // Trending event
  if (candidate.signals.trending) {
    const tr = candidate.signals.trending;
    events.push(createEvent({
      type: 'repo_trending',
      source: 'collector:github',
      entities: [candidate.entityId],
      data: {
        metadata: {
          fullName: candidate.repoFullName,
          owner: candidate.repoFullName.split('/')[0],
          name: candidate.repoFullName.split('/')[1],
          stars: tr.stars,
        },
        starsPerDay: tr.starsPerDay,
      },
      importance: candidate.discoveryScore,
    }));
  }

  return events;
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  WorldMind Discovery + Analysis Pipeline                    ║
║  "Which new repo will blow up? Let 5 Agents decide."       ║
╚══════════════════════════════════════════════════════════════╝
`);

  const startTime = Date.now();

  // ── Phase 1: Discovery ──────────────────────────────────────

  console.log('═══ Phase 1: Discovery ═══\n');

  const pipeline = new DiscoveryPipeline({
    maxCandidates: topN * 2,
    newRepos: { token: process.env['GITHUB_TOKEN'], lookbackDays: 14, minStars: 10, maxResults: 50, enrichTop: 15 },
    hn: { topStoriesLimit: 60, newStoriesLimit: 100, bestStoriesLimit: 30, minScore: 5, maxAgeHours: 72 },
  });

  const discovery = await pipeline.discover();

  console.log(`\n  📊 Discovery Stats:`);
  console.log(`     New repos: ${discovery.stats.totalNewRepos} | HN mentions: ${discovery.stats.totalHNMentions} | Trending: ${discovery.stats.totalTrending}`);
  console.log(`     Unique repos: ${discovery.stats.uniqueRepos} | Multi-signal: ${discovery.stats.multiSignalRepos}`);

  // Take top candidates for agent analysis
  const candidates = discovery.candidates.slice(0, topN);
  console.log(`\n  Top ${candidates.length} candidates selected for Agent analysis:\n`);
  for (const c of candidates) {
    console.log(`    • ${c.repoFullName} (score: ${(c.discoveryScore * 100).toFixed(1)}%, sources: ${c.signalSources.join('+')})`);
  }

  // Convert candidates to events for agents
  const allEvents: WorldEvent[] = [];
  for (const c of candidates) {
    allEvents.push(...candidateToEvents(c));
  }

  // Deduplicate events by entity (keep highest importance per entity+type)
  const deduped = new Map<string, WorldEvent>();
  for (const e of allEvents) {
    const key = `${e.entities[0]}:${e.type}`;
    const existing = deduped.get(key);
    if (!existing || e.importance > existing.importance) {
      deduped.set(key, e);
    }
  }
  const events = [...deduped.values()];

  // ── Phase 2: Agent Analysis ─────────────────────────────────

  console.log(`\n\n═══ Phase 2: Agent Analysis (${events.length} events) ═══\n`);

  // Load knowledge base
  const knowledgeBase = new KnowledgeBase();
  await knowledgeBase.load();
  console.log(`  Knowledge base: ${knowledgeBase.size} entries`);

  // Initialize bus
  const bus = new SharedContextBus();
  bus.startCycle(1);

  const allOutputs: AgentOutput[] = [];

  // ── 2a. Trend Agent ─────────────────────────────────────────
  console.log('\n  🔍 Running Trend Agent...');
  const trendStart = Date.now();
  const trendAgent = new TrendAgent();
  configureAgent(trendAgent, knowledgeBase, bus);
  try {
    const trendOutputs = await trendAgent.analyze(events);
    allOutputs.push(...trendOutputs);
    bus.publish('trend', trendOutputs);
    console.log(`     ✅ ${trendOutputs.length} trend signal(s) (${((Date.now() - trendStart) / 1000).toFixed(1)}s)`);
    for (const o of trendOutputs) {
      console.log(`        • ${o.data['repo']}: ${o.data['predictedGrowth']} growth (${Math.round(o.confidence * 100)}%)`);
    }
  } catch (err) {
    console.error(`     ❌ Trend Agent failed: ${err}`);
  }

  // ── 2b. Network + Tech in parallel ──────────────────────────
  console.log('\n  🔍 Running Network + Tech Agents (parallel)...');
  const parallelStart = Date.now();
  const networkAgent = new NetworkAgent();
  const techAgent = new TechAgent();
  configureAgent(networkAgent, knowledgeBase, bus);
  configureAgent(techAgent, knowledgeBase, bus);

  const [networkResult, techResult] = await Promise.allSettled([
    networkAgent.analyze(events),
    techAgent.analyze(events),
  ]);

  if (networkResult.status === 'fulfilled') {
    allOutputs.push(...networkResult.value);
    bus.publish('network', networkResult.value);
    console.log(`     ✅ Network: ${networkResult.value.length} output(s)`);
  } else {
    console.error(`     ❌ Network failed: ${networkResult.reason}`);
  }

  if (techResult.status === 'fulfilled') {
    allOutputs.push(...techResult.value);
    bus.publish('tech', techResult.value);
    console.log(`     ✅ Tech: ${techResult.value.length} output(s)`);
  } else {
    console.error(`     ❌ Tech failed: ${techResult.reason}`);
  }
  console.log(`     ⏱️  Parallel: ${((Date.now() - parallelStart) / 1000).toFixed(1)}s`);

  // ── 2c. Predict Agent ───────────────────────────────────────
  console.log('\n  🎯 Running Predict Agent...');
  const predictStart = Date.now();
  const predictAgent = new PredictAgent();
  configureAgent(predictAgent, knowledgeBase, bus);
  try {
    const predictOutputs = await predictAgent.analyze(events);
    allOutputs.push(...predictOutputs);
    bus.publish('predict', predictOutputs);
    console.log(`     ✅ ${predictOutputs.length} prediction(s) (${((Date.now() - predictStart) / 1000).toFixed(1)}s)`);
    for (const o of predictOutputs) {
      const pred = o.data;
      console.log(`        • ${pred['target']}: ${pred['predictedValue']} stars in ${pred['timeframeDays']}d (conf: ${Math.round(o.confidence * 100)}%)`);
    }
  } catch (err) {
    console.error(`     ❌ Predict Agent failed: ${err}`);
  }

  // ── 2d. Challenge Agent ─────────────────────────────────────
  console.log('\n  ⚔️  Running Challenge Agent...');
  const challengeStart = Date.now();
  const challengeAgent = new ChallengeAgent();
  configureAgent(challengeAgent, knowledgeBase, bus);
  try {
    const challengeOutputs = await challengeAgent.analyze(events);
    allOutputs.push(...challengeOutputs);
    bus.publish('challenge', challengeOutputs);
    console.log(`     ✅ ${challengeOutputs.length} challenge(s) (${((Date.now() - challengeStart) / 1000).toFixed(1)}s)`);
    for (const o of challengeOutputs) {
      const target = o.data['target'] ?? '?';
      console.log(`        • ${target} → ${o.data['verdict']}: ${o.reasoning.slice(0, 60)}...`);
    }
  } catch (err) {
    console.error(`     ❌ Challenge Agent failed: ${err}`);
  }

  // ── 2e. Predict Agent Round 2: Revise after Challenge ────────
  const challengeOutputs2 = allOutputs.filter(o => o.outputType === 'prediction_challenged');
  const originalPredictions = allOutputs.filter(o => o.outputType === 'prediction_created');

  if (challengeOutputs2.length > 0 && originalPredictions.length > 0) {
    console.log('\n  🔄 Running Predict Agent Round 2 (revision after debate)...');
    const reviseStart = Date.now();
    try {
      const finalPredictions = await predictAgent.revise(originalPredictions, challengeOutputs2);
      allOutputs.push(...finalPredictions);
      bus.publish('predict-final', finalPredictions);
      console.log(`     ✅ ${finalPredictions.length} finalized prediction(s) (${((Date.now() - reviseStart) / 1000).toFixed(1)}s)`);
      for (const o of finalPredictions) {
        const d = o.data;
        const orig = d['originalValue'];
        const revised = d['revisedValue'];
        const changed = orig !== revised ? '📝 REVISED' : '✊ DEFENDED';
        console.log(`        • ${d['target']}: ${orig} → ${revised} (${changed}, conf: ${Math.round(o.confidence * 100)}%)`);
      }
    } catch (err) {
      console.error(`     ❌ Predict Round 2 failed: ${err}`);
    }
  }

  // ── Phase 3: Results ────────────────────────────────────────

  console.log(`\n\n═══ Phase 3: Final Rankings ═══\n`);

  // Build final ranking from Agent outputs
  const repoScores = new Map<string, {
    trendSignal?: AgentOutput;
    prediction?: AgentOutput;       // Round 1 prediction
    finalPrediction?: AgentOutput;  // Round 2 finalized prediction (after debate)
    challenges?: AgentOutput[];
    finalScore: number;
  }>();

  for (const o of allOutputs) {
    const repo = (o.data['repo'] ?? o.data['target'] ?? '') as string;
    if (!repo) continue;
    const entry = repoScores.get(repo) ?? { challenges: [], finalScore: 0 };

    if (o.outputType === 'trend_signal') {
      if (!entry.trendSignal || o.confidence > entry.trendSignal.confidence) {
        entry.trendSignal = o;
      }
    }
    if (o.outputType === 'prediction_created') entry.prediction = o;
    if (o.outputType === 'prediction_finalized') entry.finalPrediction = o;
    if (o.outputType === 'prediction_challenged') entry.challenges!.push(o);

    repoScores.set(repo, entry);
  }

  // Compute final scores — use finalized prediction (post-debate) when available
  for (const [repo, entry] of repoScores) {
    let score = 0;
    if (entry.trendSignal) score += entry.trendSignal.confidence * 0.3;

    // Prefer Round 2 finalized prediction over Round 1
    const bestPrediction = entry.finalPrediction ?? entry.prediction;
    if (bestPrediction) score += bestPrediction.confidence * 0.5;

    // Challenge verdicts still matter for non-finalized entries
    if (!entry.finalPrediction) {
      for (const ch of entry.challenges ?? []) {
        const verdict = String(ch.data['verdict'] ?? '').toLowerCase();
        if (verdict === 'weakened') score -= 0.1;
        if (verdict === 'rejected') score -= 0.3;
        if (verdict === 'upheld') score += 0.05;
      }
    }
    // Discovery score bonus
    const candidate = candidates.find(c => c.repoFullName === repo);
    if (candidate) score += candidate.discoveryScore * 0.2;
    entry.finalScore = Math.max(0, Math.min(1, score));
  }

  // Sort and display
  const ranked = [...repoScores.entries()]
    .sort((a, b) => b[1].finalScore - a[1].finalScore);

  console.log(`  ${'Rank'.padEnd(5)} ${'Repository'.padEnd(40)} ${'Score'.padEnd(8)} ${'Trend'.padEnd(12)} ${'Prediction (after debate)'.padEnd(30)} Debate`);
  console.log(`  ${'─'.repeat(5)} ${'─'.repeat(40)} ${'─'.repeat(8)} ${'─'.repeat(12)} ${'─'.repeat(30)} ${'─'.repeat(25)}`);

  for (let i = 0; i < ranked.length; i++) {
    const [repo, entry] = ranked[i]!;
    const rank = i + 1;
    const medal = rank <= 3 ? (['🥇', '🥈', '🥉'] as const)[rank - 1] : `#${rank}`;
    const score = `${(entry.finalScore * 100).toFixed(0)}%`;
    const trend = entry.trendSignal?.data['predictedGrowth'] ?? '-';

    // Show debate result: original → final
    let predStr: string;
    if (entry.finalPrediction) {
      const orig = entry.finalPrediction.data['originalValue'];
      const final = entry.finalPrediction.data['revisedValue'];
      const days = entry.finalPrediction.data['timeframeDays'];
      const changed = orig !== final;
      predStr = changed
        ? `${orig} → ${final} ⭐ in ${days}d`
        : `${final} ⭐ in ${days}d (held)`;
    } else if (entry.prediction) {
      predStr = `${entry.prediction.data['predictedValue']} ⭐ in ${entry.prediction.data['timeframeDays']}d`;
    } else {
      predStr = '-';
    }

    // Debate summary
    const challengeCount = entry.challenges?.length ?? 0;
    let debateStr: string;
    if (entry.finalPrediction) {
      const accepted = (entry.finalPrediction.data['acceptedChallenges'] as string[])?.length ?? 0;
      const rejected = (entry.finalPrediction.data['rejectedChallenges'] as string[])?.length ?? 0;
      debateStr = `✅${accepted} accepted, ❌${rejected} rejected`;
    } else if (challengeCount > 0) {
      debateStr = entry.challenges!.map(c => c.data['verdict']).join(', ');
    } else {
      debateStr = 'no debate';
    }

    console.log(`  ${String(medal).padEnd(5)} ${repo.padEnd(40)} ${score.padEnd(8)} ${String(trend).padEnd(12)} ${predStr.padEnd(30)} ${debateStr}`);
  }

  // ── Save results ──────────────────────────────────────────────

  const outputDir = 'data/discoveries';
  await fs.mkdir(outputDir, { recursive: true });

  const dateStr = new Date().toISOString().slice(0, 10);
  const report = {
    timestamp: new Date().toISOString(),
    discoveryStats: discovery.stats,
    candidates: candidates.map(c => ({
      repo: c.repoFullName,
      discoveryScore: c.discoveryScore,
      sources: c.signalSources,
      signals: c.signals,
    })),
    agentOutputs: allOutputs.map(o => ({
      agent: o.agentName,
      type: o.outputType,
      repo: o.data['repo'] ?? o.data['target'],
      confidence: o.confidence,
      reasoning: o.reasoning,
      data: o.data,
    })),
    rankings: ranked.map(([repo, entry], i) => ({
      rank: i + 1,
      repo,
      finalScore: entry.finalScore,
      trend: entry.trendSignal?.data['predictedGrowth'],
      predictedStars: entry.prediction?.data['predictedValue'],
      timeframe: entry.prediction?.data['timeframeDays'],
      challenges: entry.challenges?.map(c => c.data['verdict']),
    })),
    durationMs: Date.now() - startTime,
  };

  const reportPath = `${outputDir}/analysis-${dateStr}.json`;
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n  💾 Full report saved to ${reportPath}`);

  // ── Store predictions for future verification ─────────────────

  const predStore = new PredictionStore();
  await predStore.load();

  // Prefer finalized (post-debate) predictions; fall back to Round 1
  const predsToStore = allOutputs.filter(o => o.outputType === 'prediction_finalized');
  const round1Only = allOutputs
    .filter(o => o.outputType === 'prediction_created')
    .filter(o => !predsToStore.some(f => f.data['target'] === o.data['target']));
  const allPreds = [...predsToStore, ...round1Only];

  for (const o of allPreds) {
    const d = o.data;
    const target = (d['target'] ?? d['repo'] ?? '') as string;
    // Only store predictions with valid owner/repo format — skip vague targets
    if (!target || !target.match(/^[\w.-]+\/[\w.-]+$/)) {
      console.log(`     ⏭️  Skipping non-repo target: "${target}"`);
      continue;
    }

    predStore.add({
      createdAt: new Date().toISOString(),
      cycle: 1,
      statement: `${target} reaches ${d['revisedValue'] ?? d['predictedValue']} stars in ${d['timeframeDays']}d`,
      target,
      metric: 'stars',
      currentValue: d['currentValue'] as number ?? 0,
      predictedValue: (d['revisedValue'] ?? d['predictedValue']) as number,
      timeframeDays: d['timeframeDays'] as number ?? 30,
      confidence: o.confidence,
      evidence: (d['evidence'] ?? d['accepted_challenges'] ?? []) as string[],
      reasoning: o.reasoning,
      challenges: (d['rejected_challenges'] ?? []) as string[],
    });
  }

  await predStore.save();
  console.log(`  📝 ${allPreds.length} prediction(s) stored for verification (${predStore.size} total)`);
  console.log(`     Run \`npx tsx scripts/verify-predictions.ts\` to check due predictions`);

  // ── Summary ───────────────────────────────────────────────────

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  ⏱️  Total time: ${duration}s`);
  console.log(`  📊 ${discovery.stats.uniqueRepos} repos discovered → ${candidates.length} analyzed → ${ranked.length} ranked`);
  console.log(`  🤖 Agent outputs: ${allOutputs.length} total`);
  console.log(`\n✅ Discovery + Analysis complete.\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

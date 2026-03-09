#!/usr/bin/env tsx
/**
 * WorldMind Backtesting Engine
 *
 * Uses historical star data to test prediction accuracy WITHOUT waiting 30 days.
 *
 * How it works:
 * 1. Collect real star history for repos that "blew up" 1-6 months ago
 * 2. For each repo, simulate "discovery day" = day of peak velocity
 * 3. Feed only data up to discovery day + N days to the Predict Agent
 * 4. Compare prediction against actual Day 30 outcome
 * 5. Compute calibration metrics and feed back as lessons
 *
 * Usage:
 *   npx tsx scripts/backtest.ts                    # run full backtest
 *   npx tsx scripts/backtest.ts --collect-only     # just collect star histories
 *   npx tsx scripts/backtest.ts --predict-only     # skip collection, use cached data
 *   npx tsx scripts/backtest.ts --observation-days 3  # give agent 3 days of data (default: 3)
 *   npx tsx scripts/backtest.ts --fast             # Trend+Predict only, skip Challenge/Round2 (~2x faster)
 *   npx tsx scripts/backtest.ts --case storm       # run only cases matching substring
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { StarDataPoint, StarHistory } from '../src/collectors/star-history.js';
import { TrendAgent } from '../src/agents/trend.js';
import { PredictAgent } from '../src/agents/predict.js';
import { ChallengeAgent } from '../src/agents/challenge.js';
import { KnowledgeBase } from '../src/memory/knowledge-base.js';
import { SharedContextBus } from '../src/context/shared-bus.js';
import { createEvent, type WorldEvent } from '../src/types/event.js';
import type { AgentOutput } from '../src/types/agent.js';

// ─── Config ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
const collectOnly = args.includes('--collect-only');
const predictOnly = args.includes('--predict-only');
const fastMode = args.includes('--fast');
const caseFilter = args.find((_, i) => args[i - 1] === '--case') ?? null;
const observationDays = parseInt(args.find((_, i) => args[i - 1] === '--observation-days') ?? '3', 10);
const GITHUB_TOKEN = process.env['GITHUB_TOKEN'] ?? '';
const DATA_DIR = 'data/backtest';

/**
 * Repos that "blew up" in the past 1-6 months — we know their full trajectory.
 * Format: owner/repo
 * Selection criteria: had a clear viral moment, then we can see what happened after.
 */
const BACKTEST_REPOS = [
  // AI/ML viral repos (2025-2026)
  'browser-use/browser-use',         // AI browser automation, big spike
  'deepseek-ai/DeepSeek-R1',        // Reasoning model, massive spike
  'stanford-oval/storm',             // AI research tool
  'mendableai/firecrawl',           // Web scraping for LLMs
  'jina-ai/reader',                 // URL-to-LLM-friendly converter
  'cohere-ai/cohere-toolkit',       // Enterprise AI toolkit

  // DevTools that trended
  'astral-sh/uv',                   // Python package manager
  'electric-sql/pglite',            // Postgres in WASM
  'face-hh/griddycode',             // Code editor
  'zed-industries/zed',             // Code editor

  // Viral content repos
  'karpathy/LLM101n',              // Karpathy educational
  'jwasham/coding-interview-university',  // Evergreen reference
];

// ─── GitHub helpers ─────────────────────────────────────────────

function ghApi(endpoint: string): any {
  const auth = GITHUB_TOKEN ? `-H "Authorization: Bearer ${GITHUB_TOKEN}"` : '';
  const cmd = `curl -sf ${auth} -H "Accept: application/vnd.github.v3+json" "https://api.github.com${endpoint}" 2>/dev/null`;
  try {
    return JSON.parse(execSync(cmd, { timeout: 15000, encoding: 'utf-8' }));
  } catch {
    return null;
  }
}

function ghStargazerPage(owner: string, repo: string, page: number, perPage = 100): Array<{ starred_at: string }> {
  const auth = GITHUB_TOKEN ? `-H "Authorization: Bearer ${GITHUB_TOKEN}"` : '';
  const cmd = `curl -sf ${auth} -H "Accept: application/vnd.github.v3.star+json" "https://api.github.com/repos/${owner}/${repo}/stargazers?per_page=${perPage}&page=${page}" 2>/dev/null`;
  try {
    return JSON.parse(execSync(cmd, { timeout: 20000, encoding: 'utf-8' }));
  } catch {
    return [];
  }
}

/**
 * Get daily star counts for a repo. Uses strategic page sampling from Stargazers API.
 * Returns: array of { date: YYYY-MM-DD, cumulativeStars, dailyStars }
 */
function collectStarHistory(repoFullName: string): StarHistory | null {
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) return null;

  console.log(`    📡 Fetching ${repoFullName}...`);

  // Get repo metadata
  const meta = ghApi(`/repos/${repoFullName}`);
  if (!meta || meta.stargazers_count == null) {
    console.log(`       ⚠️  Could not fetch repo metadata`);
    return null;
  }
  const totalStars = meta.stargazers_count as number;
  console.log(`       ${totalStars.toLocaleString()} total stars`);

  // For repos with < 400 stars, we can just get all pages
  const perPage = 100;
  const totalPages = Math.ceil(totalStars / perPage);

  // Sample pages strategically: first, last, and evenly distributed
  const pagesToFetch: number[] = [1];
  if (totalPages <= 20) {
    // Small enough to get all
    for (let p = 2; p <= totalPages; p++) pagesToFetch.push(p);
  } else {
    // Sample 15-20 pages spread across the range
    const step = Math.max(1, Math.floor(totalPages / 18));
    for (let p = step; p < totalPages; p += step) pagesToFetch.push(p);
    pagesToFetch.push(totalPages);
  }
  // Deduplicate and sort
  const uniquePages = [...new Set(pagesToFetch)].sort((a, b) => a - b);

  console.log(`       Fetching ${uniquePages.length}/${totalPages} pages...`);

  // Collect all timestamps
  const allTimestamps: string[] = [];
  for (const page of uniquePages) {
    const stars = ghStargazerPage(owner, repo, page, perPage);
    for (const s of stars) {
      if (s.starred_at) allTimestamps.push(s.starred_at);
    }
    // No rate limiting needed — 5000 req/hr with token is plenty for ~240 requests total
  }

  if (allTimestamps.length === 0) {
    console.log(`       ⚠️  No stargazer data`);
    return null;
  }

  // Build daily time series
  const dailyMap = new Map<string, number>();
  for (const ts of allTimestamps) {
    const date = ts.slice(0, 10); // YYYY-MM-DD
    dailyMap.set(date, (dailyMap.get(date) ?? 0) + 1);
  }

  // If we sampled, we need to interpolate/scale the counts
  // Each sampled page represents ~(totalPages/uniquePages.length) actual pages
  const scaleFactor = totalPages / uniquePages.length;

  const dates = [...dailyMap.keys()].sort();
  let cumulative = 0;
  let peakDaily = 0;
  let peakDate = dates[0]!;
  const dataPoints: StarDataPoint[] = [];

  for (const date of dates) {
    const rawDaily = dailyMap.get(date)!;
    const scaledDaily = Math.round(rawDaily * scaleFactor);
    cumulative += scaledDaily;
    if (scaledDaily > peakDaily) {
      peakDaily = scaledDaily;
      peakDate = date;
    }
    dataPoints.push({ date, cumulativeStars: cumulative, dailyStars: scaledDaily });
  }

  // Normalize cumulative to match actual total
  if (cumulative > 0) {
    const normFactor = totalStars / cumulative;
    let running = 0;
    for (const dp of dataPoints) {
      dp.dailyStars = Math.round(dp.dailyStars * normFactor);
      running += dp.dailyStars;
      dp.cumulativeStars = running;
    }
    // Fix last point to exact total
    if (dataPoints.length > 0) {
      dataPoints[dataPoints.length - 1]!.cumulativeStars = totalStars;
    }
  }

  console.log(`       ✅ ${dataPoints.length} days of data, peak: ${peakDaily}/day on ${peakDate}`);

  return {
    repo: repoFullName,
    collectedAt: new Date().toISOString(),
    totalStars,
    dataPoints,
    firstStarDate: dates[0]!,
    peakDailyStars: peakDaily,
    peakDate,
    sampledTimestamps: allTimestamps,
    pagesFetched: uniquePages.length,
    sampled: uniquePages.length < totalPages,
  };
}

// ─── Backtesting logic ──────────────────────────────────────────

interface BacktestCase {
  repo: string;
  /** Day index where we "discover" the repo (peak velocity day) */
  discoveryDayIdx: number;
  /** Stars visible at discovery time */
  starsAtDiscovery: number;
  /** Stars/day at discovery */
  velocityAtDiscovery: number;
  /** Stars at discovery + observationDays */
  starsAtObservationEnd: number;
  /** Actual stars 30 days after discovery */
  actualStars30d: number;
  /** Data points visible to the agent */
  visibleData: StarDataPoint[];
  /** Full history (for analysis) */
  fullHistory: StarDataPoint[];
}

function buildBacktestCases(histories: StarHistory[], obsDays: number): BacktestCase[] {
  const cases: BacktestCase[] = [];

  for (const hist of histories) {
    const dp = hist.dataPoints;
    if (dp.length < 35) {
      console.log(`    ⏭️  ${hist.repo}: not enough data (${dp.length} days, need 35+)`);
      continue;
    }

    // Find peak velocity day (discovery moment)
    let peakIdx = 0;
    let peakVelocity = 0;
    for (let i = 1; i < dp.length - 30; i++) { // ensure 30 days after peak
      if (dp[i]!.dailyStars > peakVelocity) {
        peakVelocity = dp[i]!.dailyStars;
        peakIdx = i;
      }
    }

    if (peakVelocity < 50) {
      console.log(`    ⏭️  ${hist.repo}: peak too low (${peakVelocity}/day)`);
      continue;
    }

    const obsEndIdx = Math.min(peakIdx + obsDays, dp.length - 1);
    const day30Idx = Math.min(peakIdx + 30, dp.length - 1);

    cases.push({
      repo: hist.repo,
      discoveryDayIdx: peakIdx,
      starsAtDiscovery: dp[peakIdx]!.cumulativeStars,
      velocityAtDiscovery: peakVelocity,
      starsAtObservationEnd: dp[obsEndIdx]!.cumulativeStars,
      actualStars30d: dp[day30Idx]!.cumulativeStars,
      visibleData: dp.slice(Math.max(0, peakIdx - 7), obsEndIdx + 1), // 7 days before + observation window
      fullHistory: dp,
    });
  }

  return cases;
}

/**
 * Run the Predict pipeline on a backtest case.
 * Returns the predicted star count at Day 30.
 */
async function runPrediction(btCase: BacktestCase, kb: KnowledgeBase, fast = false): Promise<{
  predictedStars: number;
  confidence: number;
  reasoning: string;
} | null> {
  const bus = new SharedContextBus();
  bus.startCycle(1);

  // Build a fake event from the visible data
  const visible = btCase.visibleData;
  const latest = visible[visible.length - 1]!;
  const avgVelocity = visible.length > 1
    ? Math.round((latest.cumulativeStars - visible[0]!.cumulativeStars) / visible.length)
    : btCase.velocityAtDiscovery;

  const event = createEvent({
    type: 'new_repo_discovered',
    source: 'collector:backtest',
    entities: [`repo:${btCase.repo}`],
    data: {
      metadata: {
        fullName: btCase.repo,
        owner: btCase.repo.split('/')[0],
        name: btCase.repo.split('/')[1],
        stars: latest.cumulativeStars,
        description: `[backtest] Peak velocity: ${btCase.velocityAtDiscovery}/day`,
        language: null,
        topics: [],
        forks: 0,
        isFork: false,
      },
      starsPerDay: avgVelocity,
      velocityTier: avgVelocity > 1000 ? 'viral' : avgVelocity > 200 ? 'fast' : 'moderate',
      // Include visible daily data as a signal
      dailyStarHistory: visible.map(d => `${d.date}: +${d.dailyStars}`).join(', '),
    },
    importance: 0.9,
  });

  // Run Trend → Predict → Challenge → Round 2
  const trendAgent = new TrendAgent();
  trendAgent.setKnowledgeBase(kb);
  trendAgent.setSharedBus(bus);
  const trendOutputs = await trendAgent.analyze([event]);
  bus.publish('trend', trendOutputs);

  const predictAgent = new PredictAgent();
  predictAgent.setKnowledgeBase(kb);
  predictAgent.setSharedBus(bus);
  const predictions = await predictAgent.analyze([event]);
  bus.publish('predict', predictions);

  let finalPredictions = predictions;

  if (!fast) {
    const challengeAgent = new ChallengeAgent();
    challengeAgent.setKnowledgeBase(kb);
    challengeAgent.setSharedBus(bus);
    const challenges = await challengeAgent.analyze([event]);
    bus.publish('challenge', challenges);

    // Round 2
    if (challenges.length > 0 && predictions.length > 0) {
      finalPredictions = await predictAgent.revise(predictions, challenges);
    }
  }

  // Find the best prediction for this repo
  const pred = finalPredictions.find(p =>
    (p.data['target'] === btCase.repo || p.data['repo'] === btCase.repo) &&
    p.outputType !== 'prediction_challenged'
  );

  if (!pred) return null;

  return {
    predictedStars: (pred.data['revisedValue'] ?? pred.data['predictedValue'] ?? 0) as number,
    confidence: pred.confidence,
    reasoning: pred.reasoning,
  };
}

// ─── Calibration metrics ────────────────────────────────────────

interface CalibrationResult {
  repo: string;
  predicted: number;
  actual: number;
  confidence: number;
  error: number;          // (predicted - actual) / actual
  absError: number;
  direction: 'over' | 'under' | 'exact';
}

function computeCalibration(results: CalibrationResult[]): {
  meanError: number;
  meanAbsError: number;
  medianAbsError: number;
  overestimateRate: number;
  calibrationBias: number;   // avg signed error — positive = overestimate
  byConfidenceBucket: Array<{ bucket: string; count: number; accuracy: number }>;
} {
  const errors = results.map(r => r.error);
  const absErrors = results.map(r => r.absError).sort((a, b) => a - b);

  const meanError = errors.reduce((a, b) => a + b, 0) / errors.length;
  const meanAbsError = absErrors.reduce((a, b) => a + b, 0) / absErrors.length;
  const medianAbsError = absErrors[Math.floor(absErrors.length / 2)] ?? 0;
  const overestimateRate = results.filter(r => r.direction === 'over').length / results.length;

  // Calibration by confidence bucket
  const buckets = [
    { label: '30-50%', min: 0.3, max: 0.5 },
    { label: '50-70%', min: 0.5, max: 0.7 },
    { label: '70-90%', min: 0.7, max: 0.9 },
    { label: '90%+', min: 0.9, max: 1.0 },
  ];
  const byConfidenceBucket = buckets.map(b => {
    const inBucket = results.filter(r => r.confidence >= b.min && r.confidence < b.max + 0.01);
    const correct = inBucket.filter(r => r.absError < 0.3).length;
    return {
      bucket: b.label,
      count: inBucket.length,
      accuracy: inBucket.length > 0 ? correct / inBucket.length : 0,
    };
  });

  return { meanError, meanAbsError, medianAbsError, overestimateRate, calibrationBias: meanError, byConfidenceBucket };
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  WorldMind Backtesting Engine                               ║
║  "Test predictions against history, not against the future" ║
╚══════════════════════════════════════════════════════════════╝
  Observation window: ${observationDays} days after discovery${fastMode ? '\n  ⚡ Fast mode: Trend+Predict only (no Challenge/Round2)' : ''}${caseFilter ? `\n  🔍 Case filter: "${caseFilter}"` : ''}
`);

  await fs.mkdir(DATA_DIR, { recursive: true });
  const historyFile = path.join(DATA_DIR, 'star-histories.json');

  // ── Phase 1: Collect star histories ───────────────────────────

  let histories: StarHistory[] = [];

  if (!predictOnly) {
    console.log('═══ Phase 1: Collecting Star Histories ═══\n');

    // Load existing to avoid re-fetching
    try {
      const existing = JSON.parse(await fs.readFile(historyFile, 'utf-8')) as StarHistory[];
      const existingRepos = new Set(existing.map(h => h.repo));
      histories = existing;
      console.log(`  Loaded ${existing.length} cached histories`);

      // Only collect missing
      const missing = BACKTEST_REPOS.filter(r => !existingRepos.has(r));
      if (missing.length > 0) {
        console.log(`  Collecting ${missing.length} new repos...\n`);
        for (const repo of missing) {
          const hist = collectStarHistory(repo);
          if (hist) histories.push(hist);
        }
      }
    } catch {
      console.log(`  Collecting ${BACKTEST_REPOS.length} repos...\n`);
      for (const repo of BACKTEST_REPOS) {
        const hist = collectStarHistory(repo);
        if (hist) histories.push(hist);
      }
    }

    await fs.writeFile(historyFile, JSON.stringify(histories, null, 2));
    console.log(`\n  💾 ${histories.length} histories saved to ${historyFile}`);

    if (collectOnly) {
      console.log('\n  --collect-only flag set. Stopping.\n');
      return;
    }
  } else {
    try {
      histories = JSON.parse(await fs.readFile(historyFile, 'utf-8'));
      console.log(`  Loaded ${histories.length} cached histories`);
    } catch {
      console.error('  ❌ No cached histories. Run without --predict-only first.');
      return;
    }
  }

  // ── Phase 2: Build backtest cases ─────────────────────────────

  console.log(`\n═══ Phase 2: Building Backtest Cases ═══\n`);
  const cases = buildBacktestCases(histories, observationDays);
  // Apply case filter
  if (caseFilter) {
    const before = cases.length;
    const filtered = cases.filter(c => c.repo.toLowerCase().includes(caseFilter.toLowerCase()));
    console.log(`  Filter '${caseFilter}': ${filtered.length}/${before} cases match`);
    cases.splice(0, cases.length, ...filtered);
  }

  console.log(`\n  ${cases.length} backtest cases${fastMode ? ' (fast mode: Trend+Predict only)' : ''}\n`);

  if (cases.length === 0) {
    console.log('  No valid cases. Need repos with 35+ days of data and peak > 50 stars/day.\n');
    return;
  }

  for (const c of cases) {
    console.log(`  • ${c.repo}: peak ${c.velocityAtDiscovery}/day, ${c.starsAtDiscovery} stars at discovery, ${c.actualStars30d} at Day 30`);
  }

  // ── Phase 3: Run predictions ──────────────────────────────────

  console.log(`\n═══ Phase 3: Running Predictions ═══\n`);

  const kb = new KnowledgeBase();
  await kb.load();

  const results: CalibrationResult[] = [];

  for (const btCase of cases) {
    console.log(`\n  🎯 Predicting ${btCase.repo}...`);
    console.log(`     Visible: ${btCase.visibleData.length} days, ${btCase.starsAtObservationEnd} stars`);
    console.log(`     Actual 30d result: ${btCase.actualStars30d} stars`);

    try {
      const pred = await runPrediction(btCase, kb, fastMode);
      if (!pred) {
        console.log(`     ⚠️  No prediction produced`);
        continue;
      }

      const error = (pred.predictedStars - btCase.actualStars30d) / btCase.actualStars30d;
      const absError = Math.abs(error);
      const direction = error > 0.05 ? 'over' : error < -0.05 ? 'under' : 'exact';

      results.push({
        repo: btCase.repo,
        predicted: pred.predictedStars,
        actual: btCase.actualStars30d,
        confidence: pred.confidence,
        error,
        absError,
        direction,
      });

      const emoji = absError < 0.3 ? '✅' : absError < 0.5 ? '🟡' : '❌';
      console.log(`     Predicted: ${pred.predictedStars} (conf: ${Math.round(pred.confidence * 100)}%)`);
      console.log(`     ${emoji} Error: ${error > 0 ? '+' : ''}${Math.round(error * 100)}% (${direction}estimate)`);
    } catch (err) {
      console.error(`     ❌ Failed: ${err}`);
    }
  }

  // ── Phase 4: Calibration Report ───────────────────────────────

  if (results.length === 0) {
    console.log('\n  No results to calibrate.\n');
    return;
  }

  console.log(`\n\n═══ Phase 4: Calibration Report ═══\n`);

  const cal = computeCalibration(results);

  console.log(`  📊 ${results.length} predictions evaluated\n`);
  console.log(`  Mean signed error:     ${cal.meanError > 0 ? '+' : ''}${Math.round(cal.meanError * 100)}% (${cal.meanError > 0 ? '⬆️ overestimates' : '⬇️ underestimates'})`);
  console.log(`  Mean absolute error:   ${Math.round(cal.meanAbsError * 100)}%`);
  console.log(`  Median absolute error: ${Math.round(cal.medianAbsError * 100)}%`);
  console.log(`  Overestimate rate:     ${Math.round(cal.overestimateRate * 100)}%`);

  console.log(`\n  Calibration by confidence bucket:`);
  console.log(`  ${'Bucket'.padEnd(10)} ${'Count'.padEnd(8)} Accuracy (within ±30%)`);
  for (const b of cal.byConfidenceBucket) {
    if (b.count === 0) continue;
    console.log(`  ${b.bucket.padEnd(10)} ${String(b.count).padEnd(8)} ${Math.round(b.accuracy * 100)}%`);
  }

  // Per-repo breakdown
  console.log(`\n  Per-repo results:`);
  console.log(`  ${'Repo'.padEnd(40)} ${'Predicted'.padEnd(12)} ${'Actual'.padEnd(12)} ${'Error'.padEnd(10)} ${'Conf'.padEnd(8)} Grade`);
  console.log(`  ${'─'.repeat(40)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(5)}`);
  for (const r of results.sort((a, b) => a.absError - b.absError)) {
    const grade = r.absError < 0.15 ? 'A' : r.absError < 0.3 ? 'B' : r.absError < 0.5 ? 'C' : 'F';
    const errorStr = `${r.error > 0 ? '+' : ''}${Math.round(r.error * 100)}%`;
    console.log(`  ${r.repo.padEnd(40)} ${String(r.predicted).padEnd(12)} ${String(r.actual).padEnd(12)} ${errorStr.padEnd(10)} ${(Math.round(r.confidence * 100) + '%').padEnd(8)} ${grade}`);
  }

  // ── Phase 5: Generate calibration lesson ──────────────────────

  const lessonContent = [
    `Calibration from ${results.length} backtests (observation window: ${observationDays} days):`,
    `- Systematic bias: ${cal.meanError > 0 ? 'OVERESTIMATES' : 'UNDERESTIMATES'} by ${Math.round(Math.abs(cal.meanError) * 100)}% on average`,
    `- Median absolute error: ${Math.round(cal.medianAbsError * 100)}%`,
    `- Overestimate rate: ${Math.round(cal.overestimateRate * 100)}%`,
    `- Correction factor: multiply raw predictions by ${(1 / (1 + cal.meanError)).toFixed(2)} to debias`,
    `- High confidence (>70%) predictions are ${
      cal.byConfidenceBucket.find(b => b.bucket === '70-90%')?.accuracy ?? 0 > 0.5
        ? 'reasonably calibrated'
        : 'still poorly calibrated — lower your confidence'
    }`,
  ].join('\n');

  console.log(`\n  📝 Calibration lesson:\n`);
  console.log(`  ${lessonContent.split('\n').join('\n  ')}`);

  // Save calibration data
  const calibrationFile = path.join(DATA_DIR, 'calibration.json');
  await fs.writeFile(calibrationFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    observationDays,
    repoCount: results.length,
    calibration: cal,
    results,
    lesson: lessonContent,
  }, null, 2));
  console.log(`\n  💾 Calibration saved to ${calibrationFile}`);

  // Update the prediction_calibration entry in knowledge.json (precise, not a new file)
  const knowledgeFile = 'data/knowledge/knowledge.json';
  try {
    const raw = await fs.readFile(knowledgeFile, 'utf-8');
    const entries = JSON.parse(raw) as Array<Record<string, unknown>>;
    const idx = entries.findIndex(e => e['topic'] === 'prediction_calibration');
    const entry = {
      topic: 'prediction_calibration',
      content: lessonContent,
      relevance: 1.0,
      source: 'backtest',
      lastUpdated: new Date().toISOString(),
    };
    if (idx >= 0) {
      entries[idx] = entry;
    } else {
      entries.push(entry);
    }
    await fs.writeFile(knowledgeFile, JSON.stringify(entries, null, 2));
    console.log(`  📚 Updated prediction_calibration in ${knowledgeFile}`);
  } catch (err) {
    console.error(`  ⚠️  Could not update knowledge.json: ${err}`);
  }

  console.log(`\n✅ Backtest complete. Use calibration data to improve predictions.\n`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

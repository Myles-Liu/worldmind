#!/usr/bin/env tsx
/**
 * Run the WorldMind Discovery Pipeline
 * 
 * Scans GitHub new repos + Hacker News + trending to find
 * candidate repos that might blow up.
 * 
 * Usage:
 *   npx tsx scripts/run-discovery.ts
 *   npx tsx scripts/run-discovery.ts --top 20
 *   npx tsx scripts/run-discovery.ts --save
 */

import { DiscoveryPipeline, type RepoCandidate } from '../src/collectors/discovery.js';
import { mkdirSync, writeFileSync } from 'node:fs';

// ─── Parse args ─────────────────────────────────────────────────

const args = process.argv.slice(2);
const topN = parseInt(args.find((_, i) => args[i - 1] === '--top') ?? '20', 10);
const shouldSave = args.includes('--save');

// ─── Run ────────────────────────────────────────────────────────

console.log(`
╔══════════════════════════════════════════════════╗
║  WorldMind Discovery Pipeline                    ║
║  "Which new repo will blow up?"                  ║
╚══════════════════════════════════════════════════╝
`);

const pipeline = new DiscoveryPipeline({
  maxCandidates: topN * 2, // get extras for filtering
  newRepos: {
    token: process.env['GITHUB_TOKEN'],
    lookbackDays: 14,
    minStars: 10,
    maxResults: 50,
    enrichTop: 15,
  },
  hn: {
    topStoriesLimit: 60,
    newStoriesLimit: 100,
    bestStoriesLimit: 30,
    minScore: 5,
    maxAgeHours: 72,
  },
});

const result = await pipeline.discover();

// ─── Display results ────────────────────────────────────────────

console.log(`
━━━ Discovery Stats ━━━
  New repos with traction:  ${result.stats.totalNewRepos}
  HN GitHub mentions:       ${result.stats.totalHNMentions}
  GitHub trending:          ${result.stats.totalTrending}
  Unique repos found:       ${result.stats.uniqueRepos}
  Multi-signal repos:       ${result.stats.multiSignalRepos} ⭐
`);

console.log(`━━━ Top ${Math.min(topN, result.candidates.length)} Candidates ━━━\n`);

const display = result.candidates.slice(0, topN);

for (let i = 0; i < display.length; i++) {
  const c = display[i]!;
  const rank = i + 1;
  const medal = rank <= 3 ? (['🥇', '🥈', '🥉'] as const)[rank - 1] : `#${rank}`;

  const stars = c.signals.newRepo?.stars ?? c.signals.trending?.stars ?? '?';
  const velocity = c.signals.newRepo?.starsPerDay ?? c.signals.trending?.starsPerDay ?? 0;
  const age = c.signals.newRepo?.daysSinceCreation
    ? `${Math.round(c.signals.newRepo.daysSinceCreation)}d old`
    : '';
  const desc = c.signals.newRepo?.description ?? '';
  const lang = c.signals.newRepo?.language ?? '';
  const sources = c.signalSources.join(' + ');
  const hnInfo = c.signals.hn
    ? `  HN: ${c.signals.hn.score}pts/${c.signals.hn.comments}comments`
    : '';
  const followers = c.signals.newRepo?.ownerFollowers ?? 0;
  const followerStr = followers > 0 ? `  👤 ${followers} followers` : '';

  console.log(`${medal} ${c.repoFullName}`);
  console.log(`   Score: ${(c.discoveryScore * 100).toFixed(1)}%  ⭐ ${stars} (${velocity.toFixed(1)}/day)  ${age}`);
  console.log(`   ${lang ? lang + ' | ' : ''}Sources: ${sources}${hnInfo}${followerStr}`);
  if (desc) console.log(`   "${desc.slice(0, 100)}${desc.length > 100 ? '...' : ''}"`);
  console.log();
}

// ─── Save results ───────────────────────────────────────────────

if (shouldSave) {
  const dir = 'data/discoveries';
  mkdirSync(dir, { recursive: true });

  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `${dir}/discovery-${dateStr}.json`;

  writeFileSync(filename, JSON.stringify(result, null, 2));
  console.log(`💾 Saved to ${filename}`);
}

// ─── Multi-signal highlights ────────────────────────────────────

const multiSignal = result.candidates.filter(c => c.signalSources.length >= 2);
if (multiSignal.length > 0) {
  console.log(`\n━━━ 🔥 Multi-Signal Repos (strongest predictors) ━━━\n`);
  for (const c of multiSignal) {
    console.log(`  ${c.repoFullName} — seen in: ${c.signalSources.join(' + ')} — score: ${(c.discoveryScore * 100).toFixed(1)}%`);
  }
}

console.log(`\n✅ Discovery complete at ${result.scanTimestamp}`);

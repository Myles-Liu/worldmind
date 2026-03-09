#!/usr/bin/env tsx
/**
 * WorldMind Prediction Verifier
 *
 * Checks due predictions against GitHub API, records actual values,
 * and prints a track record report.
 *
 * Usage:
 *   npx tsx scripts/verify-predictions.ts           # verify due predictions
 *   npx tsx scripts/verify-predictions.ts --all      # show all predictions
 *   npx tsx scripts/verify-predictions.ts --force    # verify ALL pending (ignore timeframe)
 *   npx tsx scripts/verify-predictions.ts --dry-run  # check without saving
 */

import { execSync } from 'node:child_process';
import { PredictionStore } from '../src/memory/prediction-store.js';

const GITHUB_TOKEN = process.env['GITHUB_TOKEN'] ?? '';
const args = process.argv.slice(2);
const showAll = args.includes('--all');
const forceAll = args.includes('--force');
const dryRun = args.includes('--dry-run');

// ─── GitHub API (via curl — Node fetch doesn't honor HTTPS_PROXY) ──

function getRepoStars(repoFullName: string): number | null {
  // Only accept owner/repo format
  if (!repoFullName.match(/^[\w.-]+\/[\w.-]+$/)) {
    console.error(`    ⚠️  Invalid repo format: "${repoFullName}" — skipping`);
    return null;
  }

  const authHeader = GITHUB_TOKEN ? `-H "Authorization: Bearer ${GITHUB_TOKEN}"` : '';
  const cmd = `curl -sf ${authHeader} -H "Accept: application/vnd.github.v3+json" "https://api.github.com/repos/${repoFullName}" 2>/dev/null`;

  try {
    const out = execSync(cmd, { timeout: 15000, encoding: 'utf-8' });
    const data = JSON.parse(out);
    return data.stargazers_count ?? null;
  } catch {
    console.error(`    ⚠️  GitHub API failed for ${repoFullName}`);
    return null;
  }
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  const store = new PredictionStore();
  await store.load();

  const stats = store.getStats();
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  WorldMind Prediction Verifier                              ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);
  console.log(`  📊 Total: ${stats.total} | Pending: ${stats.pending} | ✅ Correct: ${stats.correct} | ❌ Incorrect: ${stats.incorrect}`);
  if (stats.correct + stats.incorrect > 0) {
    console.log(`  🎯 Accuracy: ${Math.round(stats.accuracy * 100)}% (${stats.correct}/${stats.correct + stats.incorrect})`);
  }

  if (stats.total === 0) {
    console.log('\n  No predictions stored yet. Run the analysis pipeline first.\n');
    return;
  }

  // ── Check due predictions ───────────────────────────────────

  const due = forceAll ? store.getPending() : store.getDue();

  if (due.length > 0) {
    console.log(`\n  ⏰ ${due.length} prediction(s) ${forceAll ? '(force-checking all pending)' : 'due for verification'}:\n`);

    for (const pred of due) {
      console.log(`  ─── ${pred.target} ───`);
      console.log(`    Statement: ${pred.statement}`);
      console.log(`    Predicted: ${pred.predictedValue} ⭐ (was ${pred.currentValue} at prediction time)`);
      console.log(`    Confidence: ${Math.round(pred.confidence * 100)}%`);
      console.log(`    Created: ${pred.createdAt}`);

      const actualStars = getRepoStars(pred.target);
      if (actualStars === null) {
        console.log(`    ⚠️  Could not fetch actual stars — skipping\n`);
        continue;
      }

      const ratio = pred.predictedValue !== 0 ? actualStars / pred.predictedValue : 0;
      const pctError = Math.round(Math.abs(ratio - 1) * 100);
      const direction = actualStars >= pred.currentValue ? '📈' : '📉';
      const withinTolerance = ratio >= 0.7 && ratio <= 1.3;

      console.log(`    Actual: ${actualStars} ⭐ ${direction} (${pctError}% ${ratio >= 1 ? 'above' : 'below'} prediction)`);
      console.log(`    Verdict: ${withinTolerance ? '✅ CORRECT (within 30% tolerance)' : '❌ INCORRECT'}`);

      if (!dryRun) {
        store.verify(
          pred.id,
          actualStars,
          `Auto-verified. Predicted ${pred.predictedValue}, actual ${actualStars} (${pctError}% error). Created ${pred.createdAt.slice(0, 10)}.`
        );
      } else {
        console.log(`    [dry-run] Would save verification`);
      }
      console.log();
    }

    if (!dryRun) {
      await store.save();
      const newStats = store.getStats();
      console.log(`  💾 Results saved. Updated accuracy: ${Math.round(newStats.accuracy * 100)}% (${newStats.correct}/${newStats.correct + newStats.incorrect})\n`);
    }
  } else {
    console.log(`\n  ✅ No predictions due for verification yet.\n`);
    const pending = store.getPending();
    if (pending.length > 0) {
      console.log(`  ⏳ ${pending.length} pending prediction(s):\n`);
      for (const pred of pending) {
        const createdAt = new Date(pred.createdAt).getTime();
        const dueAt = createdAt + pred.timeframeDays * 24 * 60 * 60 * 1000;
        const daysLeft = Math.ceil((dueAt - Date.now()) / (24 * 60 * 60 * 1000));
        console.log(`    • ${pred.target}: ${pred.predictedValue} ⭐ in ${pred.timeframeDays}d (${daysLeft}d remaining, conf: ${Math.round(pred.confidence * 100)}%)`);
      }
      console.log(`\n  Use --force to verify now (before timeframe expires).\n`);
    }
  }

  // ── Show all predictions if requested ─────────────────────────

  if (showAll) {
    console.log(`\n  ═══ All Predictions ═══\n`);
    console.log(`  ${'Status'.padEnd(12)} ${'Target'.padEnd(35)} ${'Predicted'.padEnd(12)} ${'Actual'.padEnd(12)} ${'Confidence'.padEnd(12)} Created`);
    console.log(`  ${'─'.repeat(12)} ${'─'.repeat(35)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(10)}`);

    const allPreds = [...store.getPending(), ...store.getDue()];
    // Access all via getStats trick — we just iterate
    // Actually, let's use the track record formatter
    console.log('\n' + store.formatTrackRecord(50));
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

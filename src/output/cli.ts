import chalk from 'chalk';
import type { AgentOutput } from '../types/agent.js';
import type { WorldEvent } from '../types/event.js';
import type { WorldBeliefState } from '../world-model/belief-state.js';

export function printCycleHeader(cycleNumber: number): void {
  console.log('\n' + chalk.cyan('═'.repeat(60)));
  console.log(chalk.cyan.bold(`  🌍 WorldMind — Cycle #${cycleNumber}`));
  console.log(chalk.cyan(`  ${new Date().toISOString()}`));
  console.log(chalk.cyan('═'.repeat(60)));
}

export function printCollectionSummary(events: WorldEvent[]): void {
  console.log('\n' + chalk.yellow.bold('📡 Perception'));
  console.log(chalk.yellow(`  Collected ${events.length} events`));

  const byType = new Map<string, number>();
  for (const e of events) {
    byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  }
  for (const [type, count] of byType) {
    console.log(chalk.yellow(`    ${type}: ${count}`));
  }
}

export function printAgentOutputs(outputs: AgentOutput[]): void {
  if (outputs.length === 0) {
    console.log('\n' + chalk.gray('  No significant signals detected'));
    return;
  }

  console.log('\n' + chalk.green.bold('🧠 Agent Analysis'));

  for (const output of outputs) {
    const conf = Math.round(output.confidence * 100);
    const confColor = conf >= 70 ? chalk.green : conf >= 40 ? chalk.yellow : chalk.red;

    console.log('');
    console.log(chalk.white.bold(`  📊 ${output.outputType.toUpperCase()}`));
    console.log(chalk.white(`  Agent: ${output.agentName} | Confidence: ${confColor(`${conf}%`)}`));

    // ─── Trend Signal ───────────────────────────────────────────
    if (output.outputType === 'trend_signal') {
      if (output.data['repo']) {
        console.log(chalk.white(`  Repo: ${chalk.bold(output.data['repo'] as string)}`));
      }
      if (output.data['stars']) {
        console.log(chalk.white(`  Stars: ${output.data['stars']} | Stars/Day: ${output.data['starsPerDay'] ?? 'N/A'}`));
      }
      if (output.data['predictedGrowth']) {
        const growth = output.data['predictedGrowth'] as string;
        const growthIcon = growth === 'explosive' ? '🚀' : growth === 'fast' ? '⚡' : growth === 'moderate' ? '📈' : '🐢';
        console.log(chalk.white(`  Growth: ${growthIcon} ${growth}`));
      }
      if (output.data['keyFactors']) {
        const factors = output.data['keyFactors'] as string[];
        console.log(chalk.white(`  Key factors: ${factors.join(', ')}`));
      }
    }

    // ─── Network Update ─────────────────────────────────────────
    if (output.outputType === 'network_update') {
      const clusters = (output.data['clusters'] as any[]) ?? [];
      const keyPlayers = (output.data['keyPlayers'] as any[]) ?? [];
      const insights = (output.data['insights'] as string[]) ?? [];

      if (clusters.length > 0) {
        console.log(chalk.white(`  Clusters:`));
        for (const c of clusters.slice(0, 5)) {
          const relIcon = c.relationship === 'competing' ? '⚔️' : c.relationship === 'complementary' ? '🤝' : c.relationship === 'ecosystem' ? '🌐' : '🏢';
          console.log(chalk.white(`    ${relIcon} ${c.theme} (${c.relationship})`));
          console.log(chalk.gray(`      Repos: ${(c.repos as string[]).join(', ')}`));
        }
      }

      if (keyPlayers.length > 0) {
        console.log(chalk.white(`  Key Players:`));
        for (const kp of keyPlayers.slice(0, 5)) {
          const roleIcon = kp.role === 'leader' ? '👑' : kp.role === 'challenger' ? '🥊' : kp.role === 'emerging' ? '🌱' : '🔬';
          console.log(chalk.white(`    ${roleIcon} ${kp.repo} (${kp.role}): ${kp.reasoning}`));
        }
      }

      if (insights.length > 0) {
        console.log(chalk.white(`  Insights:`));
        for (const insight of insights.slice(0, 3)) {
          console.log(chalk.white(`    💡 ${insight}`));
        }
      }
    }

    // ─── Tech Trend ─────────────────────────────────────────────
    if (output.outputType === 'tech_trend') {
      const rising = (output.data['risingTechnologies'] as any[]) ?? [];
      const declining = (output.data['decliningTechnologies'] as any[]) ?? [];
      const patterns = (output.data['emergingPatterns'] as string[]) ?? [];

      if (rising.length > 0) {
        console.log(chalk.green(`  📈 Rising Technologies:`));
        for (const tech of rising) {
          const confPct = Math.round((tech.confidence ?? 0) * 100);
          console.log(chalk.green(`    ↑ ${tech.name} (${confPct}%): ${tech.signal}`));
        }
      }

      if (declining.length > 0) {
        console.log(chalk.red(`  📉 Declining Technologies:`));
        for (const tech of declining) {
          const confPct = Math.round((tech.confidence ?? 0) * 100);
          console.log(chalk.red(`    ↓ ${tech.name} (${confPct}%): ${tech.signal}`));
        }
      }

      if (patterns.length > 0) {
        console.log(chalk.white(`  Emerging Patterns:`));
        for (const pattern of patterns) {
          console.log(chalk.white(`    🔮 ${pattern}`));
        }
      }
    }

    // ─── Prediction Created ─────────────────────────────────────
    if (output.outputType === 'prediction_created') {
      const statement = output.data['statement'] as string | undefined;
      const target = output.data['target'] as string | undefined;
      const metric = output.data['metric'] as string | undefined;
      const timeframe = output.data['timeframeDays'] as number | undefined;
      const currentVal = output.data['currentValue'] as number | undefined;
      const predictedVal = output.data['predictedValue'] as number | undefined;

      if (statement) {
        console.log(chalk.magenta(`  🎯 ${statement}`));
      }
      if (target) {
        console.log(chalk.white(`  Target: ${target} | Metric: ${metric ?? 'N/A'}`));
      }
      if (timeframe) {
        console.log(chalk.white(`  Timeframe: ${timeframe} days`));
      }
      if (currentVal !== undefined && predictedVal !== undefined) {
        console.log(chalk.white(`  Current: ${currentVal} → Predicted: ${predictedVal}`));
      }
      const evidence = (output.data['evidence'] as string[]) ?? [];
      if (evidence.length > 0) {
        console.log(chalk.gray(`  Evidence: ${evidence.join('; ')}`));
      }
    }

    // ─── Prediction Challenged ──────────────────────────────────
    if (output.outputType === 'prediction_challenged') {
      const verdict = output.data['verdict'] as string | undefined;
      const revisedConf = output.data['revisedConfidence'] as number | undefined;
      const counterEvidence = (output.data['counterEvidence'] as string[]) ?? [];
      const logicalFlaws = (output.data['logicalFlaws'] as string[]) ?? [];
      const risks = (output.data['risks'] as string[]) ?? [];
      const originalPred = output.data['originalPrediction'] as string | undefined;

      const verdictIcon = verdict === 'upheld' ? '✅' : verdict === 'weakened' ? '⚠️' : '❌';
      const verdictColor = verdict === 'upheld' ? chalk.green : verdict === 'weakened' ? chalk.yellow : chalk.red;

      if (originalPred) {
        console.log(chalk.white(`  Prediction: ${originalPred}`));
      }
      console.log(verdictColor(`  ${verdictIcon} Verdict: ${verdict?.toUpperCase() ?? 'UNKNOWN'}`));
      if (revisedConf !== undefined) {
        console.log(chalk.white(`  Revised Confidence: ${Math.round(revisedConf * 100)}%`));
      }
      if (counterEvidence.length > 0) {
        console.log(chalk.yellow(`  Counter-evidence:`));
        for (const ce of counterEvidence.slice(0, 3)) {
          console.log(chalk.yellow(`    • ${ce}`));
        }
      }
      if (logicalFlaws.length > 0) {
        console.log(chalk.red(`  Logical flaws:`));
        for (const flaw of logicalFlaws.slice(0, 3)) {
          console.log(chalk.red(`    • ${flaw}`));
        }
      }
      if (risks.length > 0) {
        console.log(chalk.yellow(`  Risks:`));
        for (const risk of risks.slice(0, 3)) {
          console.log(chalk.yellow(`    • ${risk}`));
        }
      }
    }

    console.log(chalk.gray(`  Reasoning: ${output.reasoning}`));
  }
}

export function printWorldModelSummary(beliefState: WorldBeliefState | null): void {
  console.log('\n' + chalk.blue.bold('🌐 World Model'));
  if (!beliefState) {
    console.log(chalk.gray('  No world model available yet.'));
    return;
  }
  console.log(chalk.blue(`  Updated: cycle #${beliefState.cycle} (${beliefState.updatedAt.slice(0, 16)})`));
  console.log(chalk.blue(`  Confidence: ${Math.round(beliefState.confidence * 100)}%`));

  // Print summary (truncated for terminal)
  const summaryLines = beliefState.summary.split('\n').filter(Boolean);
  for (const line of summaryLines.slice(0, 4)) {
    console.log(chalk.white(`  ${line.trim()}`));
  }
  if (summaryLines.length > 4) {
    console.log(chalk.gray(`  ... (${summaryLines.length - 4} more lines)`));
  }

  if (beliefState.topTrends.length > 0) {
    console.log(chalk.blue(`  Top trends: ${beliefState.topTrends.slice(0, 5).join(', ')}`));
  }
  if (beliefState.keyPlayers.length > 0) {
    console.log(chalk.blue(`  Key players: ${beliefState.keyPlayers.slice(0, 5).join(', ')}`));
  }
  if (beliefState.predictions.length > 0) {
    console.log(chalk.blue(`  Active predictions: ${beliefState.predictions.length}`));
  }
}

export function printPredictionStats(stats: {
  total: number;
  pending: number;
  correct: number;
  incorrect: number;
  accuracy: number;
}): void {
  console.log('\n' + chalk.magenta.bold('🎯 Prediction Tracker'));
  console.log(chalk.magenta(`  Total: ${stats.total} | Pending: ${stats.pending} | ✅ Correct: ${stats.correct} | ❌ Incorrect: ${stats.incorrect}`));
  if (stats.correct + stats.incorrect > 0) {
    console.log(chalk.magenta(`  Accuracy: ${Math.round(stats.accuracy * 100)}%`));
  }
}

export function printAgentMemorySizes(memorySizes: Record<string, number>): void {
  console.log('\n' + chalk.gray.bold('🧠 Agent Memory'));
  for (const [agent, size] of Object.entries(memorySizes)) {
    console.log(chalk.gray(`  ${agent}: ${size} memories`));
  }
}

export function printCycleFooter(stats: {
  eventsCollected: number;
  entitiesTracked: number;
  signalsDetected: number;
  durationMs: number;
}): void {
  console.log('\n' + chalk.cyan('─'.repeat(60)));
  console.log(chalk.cyan(`  Events: ${stats.eventsCollected} | Entities: ${stats.entitiesTracked} | Signals: ${stats.signalsDetected}`));
  console.log(chalk.cyan(`  Duration: ${(stats.durationMs / 1000).toFixed(1)}s`));
  console.log(chalk.cyan('═'.repeat(60)) + '\n');
}

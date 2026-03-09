#!/usr/bin/env tsx
/**
 * Crypto prediction demo — validates WorldMind's domain-agnostic architecture.
 *
 * Usage:
 *   npx tsx scripts/predict-crypto.ts
 *   npx tsx scripts/predict-crypto.ts --tokens bitcoin,ethereum,solana
 */

import { CryptoDomainAdapter } from '../src/domains/crypto/adapter.js';
import { KnowledgeBase } from '../src/memory/knowledge-base.js';
import { SharedContextBus } from '../src/context/shared-bus.js';
import { BaseAgent } from '../src/agents/base-agent.js';

const tokensArg = process.argv.find(a => a.startsWith('--tokens='));
const tokens = tokensArg ? tokensArg.split('=')[1]!.split(',') : undefined;

async function main() {
  console.log(`\n🪙  WorldMind Crypto Prediction\n`);
  console.log(`${'═'.repeat(60)}\n`);

  // Create domain adapter
  const adapter = new CryptoDomainAdapter({ tokens });

  // Collect market data
  console.log('  📡 Fetching market data from CoinGecko...');
  const events = await adapter.collect();
  console.log(`     ${events.length} tokens loaded\n`);

  if (events.length === 0) {
    console.error('  ❌ No data collected. Check network/API.');
    process.exit(1);
  }

  // Show current market
  console.log('  📊 Current Market:');
  for (const e of events.slice(0, 10)) {
    const d = e.data;
    const meta = d['metadata'] as any;
    const price = d['price'] as number;
    const change24h = d['change24h'] as number;
    const change7d = d['change7d'] as number;
    const arrow24 = (change24h ?? 0) >= 0 ? '📈' : '📉';
    console.log(`     ${meta.fullName}: $${price?.toLocaleString()} ${arrow24} 24h: ${change24h?.toFixed(1)}% | 7d: ${change7d?.toFixed(1)}%`);
  }
  console.log();

  // Set up engine
  const kb = new KnowledgeBase();
  // Load crypto-specific knowledge
  for (const k of adapter.config.initialKnowledge ?? []) {
    kb.add(k);
  }

  const bus = new SharedContextBus();
  bus.startCycle(1);

  const agents = adapter.getAgents();

  // Wire up agents
  for (const agent of agents) {
    if (agent instanceof BaseAgent) {
      agent.setKnowledgeBase(kb);
      agent.setSharedBus(bus);
    }
  }

  // Run pipeline: Trend → Predict → Challenge → Round 2
  const trendAgent = agents.find(a => a.name === 'trend')!;
  const predictAgent = agents.find(a => a.name === 'predict')!;
  const challengeAgent = agents.find(a => a.name === 'challenge')!;

  console.log('═══ Agent Analysis ═══\n');

  // Trend
  const t1 = Date.now();
  const trendOutputs = await trendAgent.analyze(events);
  bus.publish('trend', trendOutputs);
  console.log(`  🔍 Trend Agent (${Math.round((Date.now() - t1) / 1000)}s)`);
  for (const o of trendOutputs) console.log(`     ${o.summary}`);
  if (trendOutputs.length === 0) console.log('     No significant trends detected.');
  console.log();

  // Predict
  const t2 = Date.now();
  const predictions = await predictAgent.analyze(events);
  bus.publish('predict', predictions);
  console.log(`  🎯 Predict Agent (${Math.round((Date.now() - t2) / 1000)}s)`);
  for (const o of predictions) console.log(`     ${o.summary}`);
  if (predictions.length === 0) console.log('     No predictions generated.');
  console.log();

  // Challenge
  const t3 = Date.now();
  const challenges = await challengeAgent.analyze(events);
  bus.publish('challenge', challenges);
  console.log(`  ⚔️  Challenge Agent (${Math.round((Date.now() - t3) / 1000)}s)`);
  for (const o of challenges) console.log(`     ${o.summary}`);
  console.log();

  // Round 2
  if (challenges.length > 0 && predictions.length > 0 && 'revise' in predictAgent) {
    const t4 = Date.now();
    const final = await (predictAgent as any).revise(predictions, challenges);
    console.log(`  🔄 Round 2 Revision (${Math.round((Date.now() - t4) / 1000)}s)`);
    for (const o of final) console.log(`     ${o.summary}`);
    console.log();

    console.log(`${'═'.repeat(60)}`);
    console.log(`\n  📋 Final Predictions:\n`);
    for (const o of final) {
      const d = o.data;
      console.log(`  • ${d['target'] ?? '?'}: ${d['originalValue'] ?? d['predictedValue']} → ${d['revisedValue'] ?? d['predictedValue']} (${d['metric'] ?? '?'}) in ${d['timeframeDays']}d`);
      console.log(`    Confidence: ${Math.round(o.confidence * 100)}%`);
      console.log(`    ${o.reasoning.slice(0, 200)}`);
      console.log();
    }
  } else if (predictions.length > 0) {
    console.log(`${'═'.repeat(60)}`);
    console.log(`\n  📋 Predictions (unchallenged):\n`);
    for (const o of predictions) {
      const d = o.data;
      console.log(`  • ${d['target'] ?? '?'}: ${d['predictedValue']} (${d['metric'] ?? '?'}) in ${d['timeframeDays']}d — ${Math.round(o.confidence * 100)}%`);
      console.log(`    ${o.reasoning.slice(0, 200)}`);
      console.log();
    }
  }

  console.log(`✅ Crypto prediction complete.\n`);
}

main().catch(console.error);

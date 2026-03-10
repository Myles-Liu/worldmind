#!/usr/bin/env tsx
/**
 * Dump all prompts that would be sent to LLM during a pipeline run.
 * Intercepts LLM calls and prints system + user prompts with token estimates.
 */

import { DiscoveryPipeline } from '../src/collectors/discovery.js';
import { TrendAgent } from '../src/agents/trend.js';
import { NetworkAgent } from '../src/agents/network.js';
import { TechAgent } from '../src/agents/tech.js';
import { PredictAgent } from '../src/agents/predict.js';
import { ChallengeAgent } from '../src/agents/challenge.js';
import { KnowledgeBase } from '../src/memory/knowledge-base.js';
import { SharedContextBus } from '../src/context/shared-bus.js';
import { createEvent, type WorldEvent } from '../src/types/event.js';
import type { BaseAgent } from '../src/agents/base-agent.js';
import { LLMClient } from '../src/llm/client.js';

// ── Monkey-patch LLM to intercept calls ──────────────────────

let callCount = 0;
const originalJson = LLMClient.prototype.json;
// @ts-expect-error monkey-patching for debug
LLMClient.prototype.json = async function(systemPrompt: string, userPrompt: string) {
  callCount++;
  const sysChars = systemPrompt.length;
  const userChars = userPrompt.length;
  const estTokens = Math.round((sysChars + userChars) / 3.5);

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`LLM CALL #${callCount} | ~${estTokens} tokens (${sysChars + userChars} chars)`);
  console.log(`${'═'.repeat(80)}`);
  
  console.log(`\n── SYSTEM PROMPT (${sysChars} chars, ~${Math.round(sysChars/3.5)} tokens) ──`);
  console.log(systemPrompt);
  
  console.log(`\n── USER PROMPT (${userChars} chars, ~${Math.round(userChars/3.5)} tokens) ──`);
  console.log(userPrompt);
  
  console.log(`\n${'─'.repeat(80)}`);
  
  // Actually call LLM
  return originalJson.call(this, systemPrompt, userPrompt);
};

// ── Run pipeline with prompt dumping ─────────────────────────

function configureAgent(agent: BaseAgent, kb: KnowledgeBase, bus: SharedContextBus): void {
  agent.setKnowledgeBase(kb);
  agent.setSharedBus(bus);
}

async function main() {
  console.log('Collecting discovery data (no LLM calls)...\n');
  
  const pipeline = new DiscoveryPipeline({
    maxCandidates: 6,
    newRepos: { token: process.env['GITHUB_TOKEN'], lookbackDays: 14, minStars: 10, maxResults: 50, enrichTop: 15 },
    hn: { topStoriesLimit: 60, newStoriesLimit: 100, bestStoriesLimit: 30, minScore: 5, maxAgeHours: 72 },
  });

  const discovery = await pipeline.discover();
  const candidates = discovery.candidates.slice(0, 3); // Only 3 to keep output manageable
  
  console.log(`Selected ${candidates.length} candidates: ${candidates.map(c => c.repoFullName).join(', ')}\n`);

  // Convert to events (same as run-discovery-analysis.ts)
  const events: WorldEvent[] = [];
  for (const c of candidates) {
    if (c.signals.newRepo) {
      const nr = c.signals.newRepo;
      events.push(createEvent({
        type: 'new_repo_discovered', source: 'collector:new-repos',
        entities: [c.entityId],
        data: {
          metadata: { fullName: c.repoFullName, owner: c.repoFullName.split('/')[0], name: c.repoFullName.split('/')[1], description: nr.description, language: nr.language, topics: nr.topics, stars: nr.stars, forks: 0, openIssues: 0, watchers: 0, license: null, createdAt: '', updatedAt: '', homepage: null, isArchived: false, isFork: false, defaultBranch: 'main' },
          starsPerDay: nr.starsPerDay, daysSinceCreation: nr.daysSinceCreation, velocityTier: nr.velocityTier, readme: nr.readme, ownerFollowers: nr.ownerFollowers, ownerType: nr.ownerType, recentCommitCount: nr.recentCommitCount, recentUniqueAuthors: nr.recentUniqueAuthors, languages: nr.languages,
        },
        importance: c.discoveryScore,
      }));
    }
    if (c.signals.hn) {
      const hn = c.signals.hn;
      events.push(createEvent({
        type: 'hn_mention', source: 'collector:hn', entities: [c.entityId],
        data: { repoFullName: c.repoFullName, hnScore: hn.score, hnComments: hn.comments, hnMentionCount: hn.mentionCount, hasShowHN: hn.hasShowHN, hnTitle: hn.title, hnPostTime: hn.postTime },
        importance: c.discoveryScore,
      }));
    }
    if (c.signals.trending) {
      const tr = c.signals.trending;
      events.push(createEvent({
        type: 'repo_trending', source: 'collector:github', entities: [c.entityId],
        data: { metadata: { fullName: c.repoFullName, owner: c.repoFullName.split('/')[0], name: c.repoFullName.split('/')[1], stars: tr.stars }, starsPerDay: tr.starsPerDay },
        importance: c.discoveryScore,
      }));
    }
  }

  const kb = new KnowledgeBase();
  await kb.load();
  const bus = new SharedContextBus();
  bus.startCycle(1);

  // Run each agent
  console.log('\n\n🔍 TREND AGENT');
  const trend = new TrendAgent(); configureAgent(trend, kb, bus);
  const trendOut = await trend.analyze(events);
  bus.publish('trend', trendOut);

  console.log('\n\n🌐 NETWORK AGENT');
  const net = new NetworkAgent(); configureAgent(net, kb, bus);
  const netOut = await net.analyze(events);
  bus.publish('network', netOut);

  console.log('\n\n🎯 PREDICT AGENT');
  const pred = new PredictAgent(); configureAgent(pred, kb, bus);
  const predOut = await pred.analyze(events);
  bus.publish('predict', predOut);

  console.log('\n\n⚔️ CHALLENGE AGENT');
  const ch = new ChallengeAgent(); configureAgent(ch, kb, bus);
  const chOut = await ch.analyze(events);
  bus.publish('challenge', chOut);

  console.log('\n\n🔄 PREDICT ROUND 2');
  const chOutputs = chOut.filter(o => o.outputType === 'prediction_challenged');
  const origPreds = predOut.filter(o => o.outputType === 'prediction_created');
  if (chOutputs.length > 0) {
    await pred.revise(origPreds, chOutputs);
  }

  console.log(`\n\n${'═'.repeat(80)}`);
  console.log(`TOTAL LLM CALLS: ${callCount}`);
}

main().catch(e => { console.error(e); process.exit(1); });

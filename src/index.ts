import { promises as fs } from 'node:fs';
import { execSync } from 'node:child_process';
import { GitHubCollector } from './collectors/github.js';
import { EntityStore } from './memory/entity-store.js';
import { EventLog } from './memory/event-log.js';
import { PredictionStore } from './memory/prediction-store.js';
import { KnowledgeBase } from './memory/knowledge-base.js';
import { TrendAgent } from './agents/trend.js';
import { NetworkAgent } from './agents/network.js';
import { TechAgent } from './agents/tech.js';
import { PredictAgent } from './agents/predict.js';
import { ChallengeAgent } from './agents/challenge.js';
import { WorldModel } from './world-model/belief-state.js';
import { SharedContextBus } from './context/shared-bus.js';
import { createEvent } from './types/event.js';
import {
  printCycleHeader,
  printCollectionSummary,
  printAgentOutputs,
  printWorldModelSummary,
  printPredictionStats,
  printAgentMemorySizes,
  printCycleFooter,
} from './output/cli.js';
import type { AgentOutput } from './types/agent.js';
import type { WorldEvent } from './types/event.js';
import type { BaseAgent } from './agents/base-agent.js';

// ─── World State ────────────────────────────────────────────────

interface WorldState {
  lastCycleNumber: number;
  lastRunAt: string;
}

async function loadWorldState(): Promise<WorldState> {
  try {
    const content = await fs.readFile('data/state.json', 'utf-8');
    return JSON.parse(content) as WorldState;
  } catch {
    return { lastCycleNumber: 0, lastRunAt: '' };
  }
}

async function saveWorldState(state: WorldState): Promise<void> {
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile('data/state.json', JSON.stringify(state, null, 2));
}

// ─── Prediction Verification via GitHub API ─────────────────────

function fetchCurrentStars(repoFullName: string, token?: string): number | null {
  try {
    const url = `https://api.github.com/repos/${repoFullName}`;
    const headers = [
      '-H', 'Accept: application/vnd.github+json',
      '-H', 'User-Agent: WorldMind/0.1',
    ];
    if (token) {
      headers.push('-H', `Authorization: Bearer ${token}`);
    }
    const result = execSync(
      `curl -s --connect-timeout 15 --max-time 30 ${headers.map(h => `'${h}'`).join(' ')} '${url}'`,
      { encoding: 'utf-8', timeout: 35_000 },
    );
    const data = JSON.parse(result);
    return typeof data.stargazers_count === 'number' ? data.stargazers_count : null;
  } catch {
    return null;
  }
}

// ─── Agent Setup Helper ─────────────────────────────────────────

/**
 * Configure an agent with shared dependencies:
 * - Knowledge base for domain knowledge
 * - SharedContextBus for inter-agent communication
 */
function configureAgent(agent: BaseAgent, knowledgeBase: KnowledgeBase, bus: SharedContextBus): void {
  agent.setKnowledgeBase(knowledgeBase);
  agent.setSharedBus(bus);
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cycles = parseInt(args.find((a, i) => args[i - 1] === '--cycles') ?? '1');
  const forceCycle = args.find((a, i) => args[i - 1] === '--cycle-number');

  console.log('🌍 WorldMind — Multi-Agent World Model Engine');
  console.log('Target: GitHub Open Source Ecosystem\n');

  // Initialize components
  const collector = new GitHubCollector();
  const entityStore = new EntityStore('data/entities');
  const eventLog = new EventLog('data/events');
  const predictionStore = new PredictionStore('data/predictions');
  const worldModel = new WorldModel('data/world-model');

  // Load existing state
  await entityStore.load();
  await predictionStore.load();
  await worldModel.load();
  const knowledgeBase = new KnowledgeBase();
  await knowledgeBase.load();
  console.log(`  Knowledge base: ${knowledgeBase.size} entries loaded`);
  const worldState = await loadWorldState();

  // Load historical events for context (last 7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const historicalEvents = await eventLog.loadRange(sevenDaysAgo, today);
  console.log(`  Loaded ${historicalEvents.length} historical events from last 7 days`);

  // Prediction store stats at startup
  const startStats = predictionStore.getStats();
  if (startStats.total > 0) {
    console.log(`  Prediction store: ${startStats.total} total, ${startStats.pending} pending, ${startStats.correct + startStats.incorrect} verified (${Math.round(startStats.accuracy * 100)}% accuracy)`);
  }

  const startingCycle = forceCycle ? parseInt(forceCycle) : worldState.lastCycleNumber + 1;

  for (let i = 0; i < cycles; i++) {
    const cycleNumber = startingCycle + i;
    const startTime = Date.now();
    printCycleHeader(cycleNumber);

    // ── 1. Perceive — collect data from GitHub ──────────────────
    console.log('\n  Collecting data from GitHub...');
    let events: WorldEvent[];
    try {
      events = await collector.collect();
    } catch (err) {
      console.error(`  ❌ Collection failed: ${err}`);
      events = [];
    }

    printCollectionSummary(events);

    // ── 2. Remember — store events ──────────────────────────────
    await eventLog.append(events);

    // Update entity store with discovered repos
    for (const event of events) {
      const metadata = event.data['metadata'] as any;
      const entityId = event.entities[0];
      if (metadata?.fullName && entityId) {
        entityStore.getOrCreate(
          entityId,
          'repo',
          metadata.fullName,
          metadata,
        );
      }
    }

    // Combine new events with historical events for richer context
    const allEventsForAgents = [...historicalEvents, ...events];

    // ── 3. Initialize SharedContextBus for this cycle ───────────
    const bus = new SharedContextBus();
    bus.startCycle(cycleNumber);
    bus.setWorldState(worldModel.getState());

    // ── 4. Reason — run agents with shared context ──────────────
    const allOutputs: AgentOutput[] = [];
    const agentMemorySizes: Record<string, number> = {};

    // ── 4a. Trend Agent (first — feeds into Network + Tech) ───────
    // Trend runs first so its outputs are available on the bus for
    // Network and Tech agents' system prompts (Layer 2 world state).
    console.log('\n  Running Trend Agent...');
    const trendStart = Date.now();
    const trendAgent = new TrendAgent();
    configureAgent(trendAgent, knowledgeBase, bus);
    try {
      const trendOutputs = await trendAgent.analyze(events);
      allOutputs.push(...trendOutputs);
      agentMemorySizes['trend'] = trendAgent['memory'].size;
      bus.publish('trend', trendOutputs);
      console.log(`    ✅ Trend Agent: ${trendOutputs.length} signal(s) (${((Date.now() - trendStart) / 1000).toFixed(1)}s)`);
    } catch (err) {
      console.error(`    ❌ Trend Agent failed: ${err}`);
    }

    // ── 4b. Network + Tech in PARALLEL ──────────────────────────
    // Both depend on Trend (now published to bus) but not on each other.
    console.log('  Running Network + Tech Agents (parallel)...');
    const parallelStart = Date.now();

    const networkAgent = new NetworkAgent();
    const techAgent = new TechAgent();
    configureAgent(networkAgent, knowledgeBase, bus);
    configureAgent(techAgent, knowledgeBase, bus);

    const [networkResult, techResult] = await Promise.allSettled([
      networkAgent.analyze(events),
      techAgent.analyze(events),
    ]);

    // Process Network results
    if (networkResult.status === 'fulfilled') {
      const networkOutputs = networkResult.value;
      allOutputs.push(...networkOutputs);
      agentMemorySizes['network'] = networkAgent['memory'].size;
      bus.publish('network', networkOutputs);
      console.log(`    ✅ Network Agent: ${networkOutputs.length} output(s)`);

      for (const o of networkOutputs) {
        await eventLog.append([createEvent({
          type: 'network_update',
          source: 'agent:network',
          entities: o.relatedEntities,
          data: o.data,
          importance: o.confidence,
        })]);
      }
    } else {
      console.error(`    ❌ Network Agent failed: ${networkResult.reason}`);
    }

    // Process Tech results
    if (techResult.status === 'fulfilled') {
      const techOutputs = techResult.value;
      allOutputs.push(...techOutputs);
      agentMemorySizes['tech'] = techAgent['memory'].size;
      bus.publish('tech', techOutputs);
      console.log(`    ✅ Tech Agent: ${techOutputs.length} output(s)`);

      for (const o of techOutputs) {
        await eventLog.append([createEvent({
          type: 'tech_trend',
          source: 'agent:tech',
          entities: o.relatedEntities,
          data: o.data,
          importance: o.confidence,
        })]);
      }
    } else {
      console.error(`    ❌ Tech Agent failed: ${techResult.reason}`);
    }

    console.log(`    ⏱️  Parallel phase: ${((Date.now() - parallelStart) / 1000).toFixed(1)}s`);

    // ── 4d. Predict Agent (reads Trend + Network + Tech via bus) ─
    // With SharedContextBus, Predict gets structured briefings from upstream
    // agents. It only needs recent events for concrete repo data, not the
    // full historical dump.
    const allEventsForPredict = events;

    console.log('\n  Running Predict Agent...');
    const predictStart = Date.now();
    const predictAgent = new PredictAgent();
    configureAgent(predictAgent, knowledgeBase, bus);
    try {
      const predictOutputs = await predictAgent.analyze(allEventsForPredict);
      console.log(`    ✅ Predict Agent: ${predictOutputs.length} prediction(s) (${((Date.now() - predictStart) / 1000).toFixed(1)}s)`);
      allOutputs.push(...predictOutputs);
      agentMemorySizes['predict'] = predictAgent['memory'].size;

      // Publish to bus for Challenge Agent
      bus.publish('predict', predictOutputs);

      // Store predictions into PredictionStore
      for (const o of predictOutputs) {
        if (o.outputType === 'prediction_created') {
          predictionStore.add({
            createdAt: new Date().toISOString(),
            cycle: cycleNumber,
            statement: (o.data['statement'] as string) ?? '',
            target: (o.data['target'] as string) ?? '',
            metric: (o.data['metric'] as string) ?? '',
            currentValue: (o.data['currentValue'] as number) ?? 0,
            predictedValue: (o.data['predictedValue'] as number) ?? 0,
            timeframeDays: (o.data['timeframeDays'] as number) ?? 30,
            confidence: o.confidence,
            evidence: (o.data['evidence'] as string[]) ?? [],
            reasoning: (o.data['reasoning'] as string) ?? o.reasoning,
          });
        }
      }

      for (const o of predictOutputs) {
        await eventLog.append([createEvent({
          type: 'prediction_created',
          source: 'agent:predict',
          entities: o.relatedEntities,
          data: o.data,
          importance: o.confidence,
        })]);
      }
    } catch (err) {
      console.error(`  ❌ Predict Agent failed: ${err}`);
    }

    // ── 4e. Challenge Agent (reads Predict's outputs via bus) ────
    console.log('  Running Challenge Agent...');
    const challengeStart = Date.now();
    const challengeAgent = new ChallengeAgent();
    configureAgent(challengeAgent, knowledgeBase, bus);
    try {
      // Challenge Agent gets predictions via bus; only needs current events for context
      const challengeOutputs = await challengeAgent.analyze(events);
      console.log(`    ✅ Challenge Agent: ${challengeOutputs.length} challenge(s) (${((Date.now() - challengeStart) / 1000).toFixed(1)}s)`);
      allOutputs.push(...challengeOutputs);
      agentMemorySizes['challenge'] = challengeAgent['memory'].size;

      // Publish to bus (no downstream consumers currently, but future-proof)
      bus.publish('challenge', challengeOutputs);
    } catch (err) {
      console.error(`  ❌ Challenge Agent failed: ${err}`);
    }

    // ── 5. Verify due predictions ───────────────────────────────
    const duePredictions = predictionStore.getDue();
    if (duePredictions.length > 0) {
      console.log(`\n  Verifying ${duePredictions.length} due prediction(s)...`);
      const ghToken = process.env['GITHUB_TOKEN'];
      for (const pred of duePredictions) {
        if (pred.metric === 'stars' && pred.target) {
          // Try to extract owner/repo from target
          const repoName = pred.target.includes('/') ? pred.target : null;
          if (repoName) {
            const currentStars = fetchCurrentStars(repoName, ghToken);
            if (currentStars !== null) {
              predictionStore.verify(pred.id, currentStars, `Auto-verified via GitHub API at cycle ${cycleNumber}`);
              console.log(`    ${pred.statement}: predicted ${pred.predictedValue}, actual ${currentStars}`);
            }
          }
        }
      }
    }

    // ── 6. Output ───────────────────────────────────────────────
    printAgentOutputs(allOutputs);

    // ── 7. Update World Model using structured bus summary ──────
    console.log('\n  Updating World Model...');

    // Use the SharedContextBus structured summary instead of raw formatting
    const agentSummary = bus.getStructuredSummary();

    try {
      await worldModel.update(cycleNumber, agentSummary);
    } catch (err) {
      console.error(`  ❌ World Model update failed: ${err}`);
    }

    // Print world model summary
    printWorldModelSummary(worldModel.getState());

    // Print prediction stats
    printPredictionStats(predictionStore.getStats());

    // Print agent memory sizes
    printAgentMemorySizes(agentMemorySizes);

    // ── 8. Save all state ───────────────────────────────────────
    await entityStore.save();
    await predictionStore.save();
    await worldModel.save();
    await saveWorldState({
      lastCycleNumber: cycleNumber,
      lastRunAt: new Date().toISOString(),
    });

    const durationMs = Date.now() - startTime;
    printCycleFooter({
      eventsCollected: events.length,
      entitiesTracked: entityStore.size,
      signalsDetected: allOutputs.length,
      durationMs,
    });
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

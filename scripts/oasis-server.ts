#!/usr/bin/env tsx
/**
 * OASIS Platform Server — Headless mode for Plan 3
 *
 * Starts the OASIS platform (Twitter-like social media simulator) and exposes
 * a JSON-lines protocol over stdin/stdout for external orchestration.
 *
 * The orchestrator (e.g., an OpenClaw agent) sends commands and receives results.
 * This decouples the platform layer from the agent layer completely.
 *
 * Commands:
 *   { cmd: "feed", agentId: N, limit: 10 }
 *   { cmd: "notifications", agentId: N, limit: 5 }
 *   { cmd: "act", decisions: [...] }
 *   { cmd: "state" }
 *   { cmd: "agents" }
 *   { cmd: "posts", limit: 20 }
 *   { cmd: "shutdown" }
 *
 * Usage:
 *   npx tsx scripts/oasis-server.ts --world cn-tech
 */

import { WorldEngine } from '../src/player/engine.js';
import { loadWorld, generateProfileCSV, buildWorldContext } from '../src/player/world-config.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';

// ─── Load env ───────────────────────────────────────────────────

try {
  const env = readFileSync(join(process.cwd(), '.env'), 'utf-8');
  for (const line of env.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#') && t.includes('=')) {
      const [k, ...v] = t.split('=');
      process.env[k!.trim()] = v.join('=').trim();
    }
  }
} catch {}

// ─── Parse args ─────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (f: string) => args.find((_, i) => args[i - 1] === `--${f}`);
const worldArg = get('world') ?? 'cn-tech';
const agentCountArg = get('agents');

// ─── Emit / Log ─────────────────────────────────────────────────

function emit(data: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(data) + '\n');
}

function log(msg: string) {
  process.stderr.write(`[oasis-server] ${msg}\n`);
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  log('Starting OASIS platform server...');

  const worldSettings = loadWorld(worldArg);
  if (agentCountArg) worldSettings.agentCount = parseInt(agentCountArg);

  const profileDir = join(process.cwd(), 'data/social');
  mkdirSync(profileDir, { recursive: true });
  const profilePath = join(profileDir, `server_${Date.now()}.csv`);
  writeFileSync(profilePath, generateProfileCSV(worldSettings), 'utf-8');

  const worldContext = buildWorldContext(worldSettings);

  const engine = new WorldEngine({
    platform: worldSettings.platform,
    agentCount: worldSettings.agentCount,
    profilePath,
    llm: {
      apiKey: process.env.WORLDMIND_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
      baseUrl: process.env.WORLDMIND_LLM_BASE_URL ?? process.env.OPENAI_API_BASE ?? '',
      model: process.env.WORLDMIND_LLM_MODEL ?? 'gpt-4o-mini',
    },
    worldContext,
  });

  log(`World: ${worldSettings.name} (${worldSettings.language})`);
  log(`Agents: ${worldSettings.agentCount}`);

  await engine.init();

  const state = engine.getWorldState();
  const agents = engine.getAgents(100);

  // Build persona map
  const personas = [];
  for (let i = 0; i < worldSettings.agentCount; i++) {
    const arch = worldSettings.archetypes[i % worldSettings.archetypes.length];
    if (!arch) continue;
    const suffix = i >= worldSettings.archetypes.length
      ? `_${Math.floor(i / worldSettings.archetypes.length) + 1}` : '';
    const oasisAgent = agents[i];
    personas.push({
      id: oasisAgent?.id ?? i,
      username: `${arch.role}${suffix}`,
      role: arch.role,
      personality: arch.personality,
    });
  }

  // Emit ready signal with all metadata
  emit({
    type: 'ready',
    world: worldSettings.name,
    worldContext,
    totalAgents: state.totalAgents,
    personas,
  });

  log('Platform ready. Listening for commands...');

  // ─── Command loop ───────────────────────────────────────────

  const rl = createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let cmd: any;
    try {
      cmd = JSON.parse(trimmed);
    } catch {
      emit({ type: 'error', message: 'invalid JSON' });
      return;
    }

    const id = cmd.id ?? 0;

    try {
      switch (cmd.cmd) {
        case 'feed': {
          const feed = await engine.queryAgentFeed(cmd.agentId ?? 0, cmd.limit ?? 10);
          emit({ type: 'feed', id, agentId: cmd.agentId, feed });
          break;
        }
        case 'notifications': {
          const notifs = await engine.queryAgentNotifications(cmd.agentId ?? 0, cmd.limit ?? 5);
          emit({ type: 'notifications', id, agentId: cmd.agentId, notifications: notifs });
          break;
        }
        case 'act': {
          const result = await engine.directedStep(cmd.decisions ?? []);
          emit({ type: 'act_result', id, ...result });
          break;
        }
        case 'state': {
          const s = engine.getWorldState();
          emit({ type: 'state', id, ...s });
          break;
        }
        case 'agents': {
          const a = engine.getAgents(cmd.limit ?? 100);
          emit({ type: 'agents', id, agents: a });
          break;
        }
        case 'posts': {
          const p = engine.getFeed(cmd.limit ?? 20);
          emit({ type: 'posts', id, posts: p });
          break;
        }
        case 'shutdown': {
          log('Shutting down...');
          await engine.shutdown();
          emit({ type: 'shutdown', id });
          process.exit(0);
          break;
        }
        default:
          emit({ type: 'error', id, message: `unknown command: ${cmd.cmd}` });
      }
    } catch (e) {
      emit({ type: 'error', id, message: (e as Error).message });
    }
  });

  rl.on('close', async () => {
    log('stdin closed, shutting down...');
    await engine.shutdown();
    process.exit(0);
  });
}

main().catch(e => {
  log(`Fatal: ${e}`);
  process.exit(1);
});

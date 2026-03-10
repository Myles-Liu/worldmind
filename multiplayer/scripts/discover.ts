#!/usr/bin/env tsx
/**
 * Discover WorldMind servers on the local network.
 *
 * Usage:
 *   npx tsx multiplayer/scripts/discover.ts
 *   npx tsx multiplayer/scripts/discover.ts --port 3000 --subnet 33.229.115
 *   npx tsx multiplayer/scripts/discover.ts --range 70-150
 */

import { scanForServers } from '../src/discovery.js';

const args = process.argv.slice(2);
const get = (f: string) => args.find((_, i) => args[i - 1] === `--${f}`);

const port = parseInt(get('port') ?? '3000');
const subnet = get('subnet');
const range = get('range');
const [rangeStart, rangeEnd] = range
  ? range.split('-').map(Number)
  : [1, 254];

async function main() {
  console.log('\n🔍 WorldMind Server Discovery');
  console.log('═'.repeat(40));

  const servers = await scanForServers({
    port,
    subnet: subnet ?? undefined,
    rangeStart,
    rangeEnd,
    timeout: 500,
    concurrency: 50,
    onLog: (m) => console.log(`  ${m}`),
  });

  if (servers.length === 0) {
    console.log('\n  No WorldMind servers found.');
    console.log('  Make sure a server is running with --host 0.0.0.0\n');
  } else {
    console.log(`\n  Found ${servers.length} server(s):\n`);
    console.log('  ┌─────────────────────────┬──────────────┬───────┬─────────┬──────────┐');
    console.log('  │ World                   │ Address      │ Round │ Players │ Uptime   │');
    console.log('  ├─────────────────────────┼──────────────┼───────┼─────────┼──────────┤');
    for (const s of servers) {
      const name = s.info.name.slice(0, 23).padEnd(23);
      const addr = `${s.ip}:${s.port}`.padEnd(12);
      const round = String(s.info.round).padEnd(5);
      const players = `${s.info.players}/${s.info.maxPlayers}`.padEnd(7);
      const uptime = formatUptime(s.info.uptime).padEnd(8);
      console.log(`  │ ${name} │ ${addr} │ ${round} │ ${players} │ ${uptime} │`);
    }
    console.log('  └─────────────────────────┴──────────────┴───────┴─────────┴──────────┘');

    console.log('\n  To join (WebSocket):');
    for (const s of servers) {
      console.log(`    npx tsx multiplayer/scripts/ai-player.ts --server ws://${s.ip}:${s.port} --name "YourName"`);
    }

    console.log('\n  To join (HTTP):');
    for (const s of servers) {
      console.log(`    curl -s http://${s.ip}:${s.port}/api/join -d '{"name":"YourName"}' -H 'Content-Type: application/json'`);
    }

    console.log('\n  Or auto-discover (no --server needed):');
    console.log('    npx tsx multiplayer/scripts/ai-player.ts --name "YourName"');
    console.log('');
  }
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

main().catch(e => { console.error('Error:', e); process.exit(1); });

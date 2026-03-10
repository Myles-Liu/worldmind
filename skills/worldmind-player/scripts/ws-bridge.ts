/**
 * WebSocket bridge for OpenClaw agent ↔ WorldMind server.
 * 
 * Communication via file-based IPC (since background exec closes stdin):
 *   - Events written to: <ipc-dir>/events.jsonl (append-only)
 *   - Commands read from: <ipc-dir>/cmd.json (agent writes, bridge reads+deletes)
 * 
 * Usage:
 *   npx tsx ws-bridge.ts --server ws://localhost:3000 --name "Tony Stark" --ipc /tmp/worldmind-player-1
 */
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';
import { scanForServers } from '../../../multiplayer/src/discovery.js';

const args = process.argv.slice(2);
const serverArg = args.indexOf('--server') >= 0 ? args[args.indexOf('--server') + 1] : undefined;
const playerName = args[args.indexOf('--name') + 1] ?? 'Player';
const ipcDir = args[args.indexOf('--ipc') + 1] ?? '/tmp/worldmind-player';

async function resolveServer(): Promise<string> {
  if (serverArg) return serverArg;

  console.log('[bridge] No --server specified, scanning for servers...');
  const servers = await scanForServers({
    timeout: 500,
    concurrency: 50,
    onLog: (m) => console.log(`[bridge] ${m}`),
  });

  if (servers.length === 0) {
    throw new Error('No WorldMind servers found. Start a server with --host 0.0.0.0 or specify --server');
  }

  const best = servers.sort((a, b) => b.info.players - a.info.players)[0]!;
  const url = `ws://${best.ip}:${best.port}`;
  console.log(`[bridge] Auto-selected: ${best.info.name} at ${url}`);
  return url;
}

async function main() {
const serverUrl = await resolveServer();

// Setup IPC directory
mkdirSync(ipcDir, { recursive: true });
const eventsFile = join(ipcDir, 'events.jsonl');
const cmdFile = join(ipcDir, 'cmd.json');
const statusFile = join(ipcDir, 'status.json');

// Clear previous state
writeFileSync(eventsFile, '', 'utf-8');
if (existsSync(cmdFile)) unlinkSync(cmdFile);
writeFileSync(statusFile, JSON.stringify({ connected: false, joined: false, playerId: null }), 'utf-8');

function emit(data: any) {
  const line = JSON.stringify(data) + '\n';
  writeFileSync(eventsFile, line, { flag: 'a' });
  // Also log to stdout for debugging
  console.log(line.trim());
}

function updateStatus(patch: Record<string, any>) {
  let status: any = {};
  try { status = JSON.parse(readFileSync(statusFile, 'utf-8')); } catch {}
  Object.assign(status, patch);
  writeFileSync(statusFile, JSON.stringify(status), 'utf-8');
}

const ws = new WebSocket(serverUrl);

ws.on('open', () => {
  emit({ event: 'connected', server: serverUrl });
  updateStatus({ connected: true });
  ws.send(JSON.stringify({ type: 'join', name: playerName }));
});

ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw.toString());
    
    switch (msg.type) {
      case 'joined':
        emit({ event: 'joined', playerId: msg.playerId, npcs: msg.npcs?.map((n: any) => ({ id: n.id, name: n.username })) });
        updateStatus({ joined: true, playerId: msg.playerId });
        break;
      case 'round_start':
        emit({ event: 'round_start', round: msg.round, feed: msg.feed, notifications: msg.notifications });
        updateStatus({ currentRound: msg.round, waitingForAction: true });
        break;
      case 'round_end':
        emit({ event: 'round_end', round: msg.round, state: msg.state });
        updateStatus({ waitingForAction: false });
        break;
      case 'action_ack':
        emit({ event: 'action_ack', success: msg.success });
        updateStatus({ waitingForAction: false, lastActionRound: msg.round });
        break;
      case 'feed_result':
        emit({ event: 'feed', feed: msg.feed });
        break;
      case 'notifications_result':
        emit({ event: 'notifications', notifications: msg.notifications });
        break;
      case 'groups_result':
        emit({ event: 'groups', groups: msg.groups, joined: msg.joined });
        break;
      case 'group_messages_result':
        emit({ event: 'group_messages', groupId: msg.groupId, messages: msg.messages });
        break;
      case 'state_result':
        emit({ event: 'state', state: msg.state });
        break;
      case 'error':
        emit({ event: 'error', message: msg.message });
        break;
      default:
        emit({ event: 'raw', data: msg });
    }
  } catch (e) {
    emit({ event: 'error', message: `parse error: ${(e as Error).message}` });
  }
});

ws.on('close', () => {
  emit({ event: 'disconnected' });
  updateStatus({ connected: false });
  process.exit(0);
});

ws.on('error', (err) => {
  emit({ event: 'error', message: err.message });
});

// Poll for commands from file system (every 1s)
setInterval(() => {
  if (!existsSync(cmdFile)) return;
  try {
    const raw = readFileSync(cmdFile, 'utf-8').trim();
    if (!raw) return;
    unlinkSync(cmdFile); // consume command
    
    const cmd = JSON.parse(raw);
    switch (cmd.cmd) {
      case 'act':
        ws.send(JSON.stringify({
          type: 'action',
          action: cmd.action,
          content: cmd.content,
          targetPostId: cmd.targetPostId,
          targetUserId: cmd.targetUserId,
          groupId: cmd.groupId,
          groupName: cmd.groupName,
        }));
        emit({ event: 'cmd_sent', action: cmd.action });
        break;
      case 'feed':
        ws.send(JSON.stringify({ type: 'feed', limit: cmd.limit ?? 10 }));
        break;
      case 'notifications':
        ws.send(JSON.stringify({ type: 'notifications', limit: cmd.limit ?? 5 }));
        break;
      case 'groups':
        ws.send(JSON.stringify({ type: 'groups' }));
        break;
      case 'group_messages':
        ws.send(JSON.stringify({ type: 'group_messages', groupId: cmd.groupId, limit: cmd.limit ?? 20 }));
        break;
      case 'state':
        ws.send(JSON.stringify({ type: 'state' }));
        break;
      case 'leave':
        ws.send(JSON.stringify({ type: 'leave' }));
        ws.close();
        break;
      default:
        emit({ event: 'error', message: `unknown cmd: ${cmd.cmd}` });
    }
  } catch (e) {
    emit({ event: 'error', message: `cmd parse error: ${(e as Error).message}` });
  }
}, 1000);

console.log(`[bridge] Server: ${serverUrl}`);
console.log(`[bridge] IPC dir: ${ipcDir}`);
console.log(`[bridge] Events: ${eventsFile}`);
console.log(`[bridge] Commands: ${cmdFile}`);
console.log(`[bridge] Status: ${statusFile}`);
} // end main

main().catch(e => { console.error('[bridge] Fatal:', e.message); process.exit(1); });

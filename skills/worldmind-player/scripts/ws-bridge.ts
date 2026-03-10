/**
 * WebSocket bridge for OpenClaw agent ↔ WorldMind server.
 * 
 * Communicates via stdin (JSON commands) / stdout (JSON events).
 * The OpenClaw agent uses exec/process tools to interact with this bridge.
 * 
 * Usage:
 *   npx tsx ws-bridge.ts --server ws://localhost:3000 --name "Tony Stark"
 */
import { createInterface } from 'readline';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const serverUrl = args[args.indexOf('--server') + 1] ?? 'ws://localhost:3000';
const playerName = args[args.indexOf('--name') + 1] ?? 'Player';

function emit(data: any) {
  console.log(JSON.stringify(data));
}

const ws = new WebSocket(serverUrl);
let joined = false;

ws.on('open', () => {
  emit({ event: 'connected', server: serverUrl });
  // Auto-join
  ws.send(JSON.stringify({ type: 'join', name: playerName }));
});

ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw.toString());
    
    switch (msg.type) {
      case 'joined':
        joined = true;
        emit({ event: 'joined', playerId: msg.playerId, npcs: msg.npcs?.map((n: any) => ({ id: n.id, name: n.username })) });
        break;
      case 'round_start':
        emit({ event: 'round_start', round: msg.round, feed: msg.feed, notifications: msg.notifications });
        break;
      case 'round_end':
        emit({ event: 'round_end', round: msg.round, state: msg.state });
        break;
      case 'action_ack':
        emit({ event: 'action_ack', success: msg.success });
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
  process.exit(0);
});

ws.on('error', (err) => {
  emit({ event: 'error', message: err.message });
});

// Read commands from stdin (JSON per line)
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  try {
    const cmd = JSON.parse(line.trim());
    
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
    emit({ event: 'error', message: `stdin parse error: ${(e as Error).message}` });
  }
});

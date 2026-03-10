/**
 * WorldMind Multiplayer Server
 *
 * An open world server that accepts external Players via WebSocket.
 * NPC agents run internally (via NpcRuntime), while Players (OpenClaw
 * instances, other AI agents, humans) connect over the network.
 *
 * Dependencies: ws (WebSocket), types.ts (self-contained)
 * Does NOT import from ../../src — fully deployable standalone.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type {
  Persona,
  Decision,
  FeedItem,
  Notification,
  WorldState,
  ClientMessage,
  ServerMessage,
  PlatformAdapter,
  NpcRuntime,
} from './types.js';

// ─── Connected Player ───────────────────────────────────────────

interface ConnectedPlayer {
  id: number;
  name: string;
  ws: WebSocket;
  pendingAction: Decision | null;
  joinedAt: number;
}

// ─── Config ─────────────────────────────────────────────────────

export interface ServerConfig {
  /** Social platform backend */
  platform: PlatformAdapter;

  /** NPC runtime (null = player-only world) */
  npcRuntime?: NpcRuntime;

  /** World context string */
  worldContext: string;

  /** NPC personas */
  npcs?: Persona[];

  /** Seconds between auto-rounds (0 = manual) */
  roundIntervalSec?: number;

  /** Max connected players */
  maxPlayers?: number;

  /** Logging callback */
  onLog?: (msg: string) => void;
}

// ─── Server ─────────────────────────────────────────────────────

export class WorldServer {
  private wss: WebSocketServer | null = null;
  private platform: PlatformAdapter;
  private npcRuntime: NpcRuntime | null;
  private worldContext: string;
  private npcs: Persona[];
  private npcSessionIds: Map<number, string> = new Map(); // agentId → sessionId

  private players: Map<WebSocket, ConnectedPlayer> = new Map();
  private maxPlayers: number;
  private roundInterval: number;
  private roundTimer: NodeJS.Timeout | null = null;
  private round = 0;
  private log: (msg: string) => void;

  constructor(config: ServerConfig) {
    this.platform = config.platform;
    this.npcRuntime = config.npcRuntime ?? null;
    this.worldContext = config.worldContext;
    this.npcs = config.npcs ?? [];
    this.maxPlayers = config.maxPlayers ?? 50;
    this.roundInterval = (config.roundIntervalSec ?? 0) * 1000;
    this.log = config.onLog ?? console.log;
  }

  async start(port: number): Promise<void> {
    // Spawn NPCs
    if (this.npcRuntime && this.npcs.length > 0) {
      this.log(`Spawning ${this.npcs.length} NPCs via ${this.npcRuntime.name}...`);
      for (const npc of this.npcs) {
        const { sessionId } = await this.npcRuntime.spawn(npc, this.worldContext);
        this.npcSessionIds.set(npc.id, sessionId);
      }
      this.log(`${this.npcSessionIds.size} NPCs ready.`);
    }

    // Start WebSocket server
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws, req) => {
      const origin = req.headers.origin ?? req.socket.remoteAddress ?? 'unknown';
      this.log(`Connection from ${origin} (${this.players.size}/${this.maxPlayers})`);
      this.handleConnection(ws);
    });

    this.log(`🌍 WorldMind Server ws://0.0.0.0:${port}`);
    this.log(`   NPCs: ${this.npcs.length} | Max players: ${this.maxPlayers}`);

    if (this.roundInterval > 0) {
      this.roundTimer = setInterval(() => this.runRound().catch(e =>
        this.log(`Round error: ${e}`)
      ), this.roundInterval);
      this.log(`   Auto-round every ${this.roundInterval / 1000}s`);
    }
  }

  async stop(): Promise<void> {
    if (this.roundTimer) clearInterval(this.roundTimer);
    if (this.npcRuntime) await this.npcRuntime.shutdownAll();
    for (const [ws] of this.players) {
      this.send(ws, { type: 'event', event: 'server_shutdown', data: {} });
      ws.close();
    }
    this.wss?.close();
    await this.platform.shutdown();
    this.log('Server stopped.');
  }

  /** Trigger a round (called by timer or externally) */
  async runRound(): Promise<void> {
    this.round++;
    this.log(`\n─── Round ${this.round} ───`);

    // 1. Push round_start to all players with their feed
    for (const [ws, player] of this.players) {
      try {
        const feed = await this.platform.queryFeed(player.id, 10);
        const notifs = await this.platform.queryNotifications(player.id, 5);
        this.send(ws, { type: 'round_start', round: this.round, feed, notifications: notifs });
      } catch (e) {
        this.log(`Feed error for ${player.name}: ${e}`);
      }
    }

    // 2. NPC decisions
    const npcDecisions: Decision[] = [];
    if (this.npcRuntime && this.npcSessionIds.size > 0) {
      const activeIds = [...this.npcSessionIds.entries()]
        .sort(() => Math.random() - 0.5)
        .slice(0, Math.max(2, Math.floor(this.npcSessionIds.size * 0.7)));

      if (this.npcRuntime.decideBatch) {
        const contexts = new Map<string, { round: number; feed: FeedItem[]; notifications: Notification[] }>();
        for (const [agentId, sessionId] of activeIds) {
          const feed = await this.platform.queryFeed(agentId, 10);
          const notifs = await this.platform.queryNotifications(agentId, 5);
          contexts.set(sessionId, { round: this.round, feed, notifications: notifs });
        }
        const ids = activeIds.map(([, sid]) => sid);
        const batch = await this.npcRuntime.decideBatch(ids, contexts);
        npcDecisions.push(...batch);
      } else {
        for (const [agentId, sessionId] of activeIds) {
          const feed = await this.platform.queryFeed(agentId, 10);
          const notifs = await this.platform.queryNotifications(agentId, 5);
          const d = await this.npcRuntime.decide(sessionId, { round: this.round, feed, notifications: notifs });
          npcDecisions.push(d);
        }
      }
    }

    // 3. Collect pending player actions
    const playerDecisions: Decision[] = [];
    for (const [, player] of this.players) {
      if (player.pendingAction) {
        playerDecisions.push(player.pendingAction);
        player.pendingAction = null;
      }
    }

    // 4. Execute all
    const all = [...npcDecisions, ...playerDecisions].filter(d => d.action !== 'do_nothing');
    if (all.length > 0) {
      await this.platform.executeBatch(all);
    }

    // 5. Broadcast round_end
    const state = this.getState();
    for (const [ws] of this.players) {
      this.send(ws, { type: 'round_end', round: this.round, state });
    }

    this.log(`Round ${this.round}: ${npcDecisions.length} NPC + ${playerDecisions.length} player actions`);
  }

  get playerCount(): number { return this.players.size; }

  // ─── Connection handling ──────────────────────────────────────

  private handleConnection(ws: WebSocket) {
    ws.on('message', async (raw) => {
      let msg: ClientMessage;
      try { msg = JSON.parse(raw.toString()); } catch {
        this.send(ws, { type: 'error', message: 'invalid JSON' });
        return;
      }
      try { await this.handleMessage(ws, msg); } catch (e) {
        this.send(ws, { type: 'error', message: (e as Error).message });
      }
    });

    ws.on('close', () => {
      const p = this.players.get(ws);
      if (p) {
        this.log(`Player left: ${p.name}`);
        this.players.delete(ws);
        this.broadcast({ type: 'event', event: 'player_left', data: { name: p.name, id: p.id } });
      }
    });
  }

  private async handleMessage(ws: WebSocket, msg: ClientMessage) {
    switch (msg.type) {
      case 'join': {
        if (this.players.size >= this.maxPlayers) {
          this.send(ws, { type: 'error', message: 'server full' });
          ws.close();
          return;
        }

        const playerId = await this.platform.registerPlayer(msg.name, msg.persona);

        this.players.set(ws, {
          id: playerId,
          name: msg.name,
          ws,
          pendingAction: null,
          joinedAt: Date.now(),
        });

        this.send(ws, { type: 'joined', playerId, worldContext: this.worldContext, npcs: this.npcs });
        this.log(`Player joined: ${msg.name} (#${playerId})`);
        this.broadcast(
          { type: 'event', event: 'player_joined', data: { name: msg.name, id: playerId } },
          ws,
        );
        break;
      }

      case 'action': {
        const p = this.players.get(ws);
        if (!p) { this.send(ws, { type: 'error', message: 'not joined' }); return; }
        p.pendingAction = {
          agentId: p.id,
          action: msg.action,
          content: msg.content,
          targetPostId: msg.targetPostId,
          targetUserId: msg.targetUserId,
          groupId: msg.groupId,
          groupName: msg.groupName,
        };
        this.send(ws, { type: 'action_ack', success: true });

        // Immediate execution if no round timer
        if (this.roundInterval === 0) {
          await this.platform.executeBatch([p.pendingAction]);
          p.pendingAction = null;
          this.send(ws, { type: 'event', event: 'action_executed', data: {} });
        }
        break;
      }

      case 'feed': {
        const p = this.players.get(ws);
        if (!p) { this.send(ws, { type: 'error', message: 'not joined' }); return; }
        const feed = await this.platform.queryFeed(p.id, msg.limit ?? 10);
        this.send(ws, { type: 'feed_result', feed });
        break;
      }

      case 'notifications': {
        const p = this.players.get(ws);
        if (!p) { this.send(ws, { type: 'error', message: 'not joined' }); return; }
        const n = await this.platform.queryNotifications(p.id, msg.limit ?? 5);
        this.send(ws, { type: 'notifications_result', notifications: n });
        break;
      }

      case 'state':
        this.send(ws, { type: 'state_result', state: this.getState() });
        break;

      case 'groups': {
        const p = this.players.get(ws);
        if (!p) { this.send(ws, { type: 'error', message: 'not joined' }); return; }
        const result = await this.platform.queryGroups(p.id);
        this.send(ws, { type: 'groups_result', ...result });
        break;
      }

      case 'group_messages': {
        const p = this.players.get(ws);
        if (!p) { this.send(ws, { type: 'error', message: 'not joined' }); return; }
        const messages = await this.platform.queryGroupMessages(msg.groupId, msg.limit ?? 20);
        this.send(ws, { type: 'group_messages_result', groupId: msg.groupId, messages });
        break;
      }

      case 'agents': {
        const npcsWithType = this.npcs.map(n => ({ ...n, type: 'npc' as const }));
        const playersWithType = [...this.players.values()].map(p => ({
          id: p.id, username: p.name, role: 'player', personality: '', type: 'player' as const,
        }));
        this.send(ws, { type: 'agents_result', agents: [...npcsWithType, ...playersWithType] });
        break;
      }

      case 'leave': {
        const p = this.players.get(ws);
        if (p) { this.players.delete(ws); this.log(`Player left: ${p.name}`); }
        ws.close();
        break;
      }
    }
  }

  private getState(): WorldState {
    const s = this.platform.getState();
    return { ...s, round: this.round, totalPlayers: this.players.size };
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage, exclude?: WebSocket) {
    for (const [ws] of this.players) {
      if (ws !== exclude) this.send(ws, msg);
    }
  }
}

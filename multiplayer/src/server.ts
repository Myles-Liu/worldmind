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
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join as pathJoin } from 'path';
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
import { HttpApi } from './http-api.js';
import { handleDiscover } from './discovery.js';
import { AdminApi } from './admin-api.js';
import { PollSystem } from './poll-system.js';
import type { DirectorNpcRuntime } from './director-runtime.js';

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

  /** Milliseconds to wait for player actions after NPC decisions (default 30000) */
  playerWaitMs?: number;

  /** Admin token (required for /api/admin/* endpoints). If omitted, admin API is disabled. */
  adminToken?: string;

  /** LLM config for poll option generation */
  llm?: { apiKey: string; baseURL: string; model: string };

  /** Logging callback */
  onLog?: (msg: string) => void;
}

// ─── Server ─────────────────────────────────────────────────────

export class WorldServer {
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private httpApi: HttpApi | null = null;
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
  private playerWaitMs: number;
  private log: (msg: string) => void;
  private startTime = Date.now();
  private listenPort = 0;
  private paused = false;
  private adminApi: AdminApi | null = null;
  private pollSystem: PollSystem | null = null;

  constructor(config: ServerConfig) {
    this.platform = config.platform;
    this.npcRuntime = config.npcRuntime ?? null;
    this.worldContext = config.worldContext;
    this.npcs = config.npcs ?? [];
    this.maxPlayers = config.maxPlayers ?? 50;
    this.playerWaitMs = config.playerWaitMs ?? 30_000;
    this.roundInterval = (config.roundIntervalSec ?? 0) * 1000;
    this.log = config.onLog ?? console.log;

    // Admin API
    if (config.adminToken) {
      this.adminApi = new AdminApi({
        adminToken: config.adminToken,
        kickPlayer: (playerId) => this.kickPlayer(playerId),
        getPlayers: () => this.listAllPlayers(),
        broadcast: (message) => this.broadcastSystemMessage(message),
        pause: () => {
          if (this.roundTimer) {
            clearInterval(this.roundTimer);
            this.roundTimer = null;
            this.paused = true;
            return true;
          }
          return false;
        },
        resume: () => {
          if (this.paused && this.roundInterval > 0) {
            this.paused = false;
            this.roundTimer = setInterval(() => this.runRound().catch(e =>
              this.log(`Round error: ${e}`)
            ), this.roundInterval);
            return true;
          }
          return false;
        },
        isPaused: () => this.paused,
        triggerRound: () => this.runRound(),
        injectEvent: (content, author) => this.injectSystemEvent(content, author),
        updateConfig: (patch) => {
          if (patch.roundInterval !== undefined) {
            this.roundInterval = patch.roundInterval * 1000;
            // Restart timer if not paused
            if (this.roundTimer) clearInterval(this.roundTimer);
            if (this.roundInterval > 0 && !this.paused) {
              this.roundTimer = setInterval(() => this.runRound().catch(e =>
                this.log(`Round error: ${e}`)
              ), this.roundInterval);
            }
          }
          if (patch.playerWait !== undefined) {
            this.playerWaitMs = patch.playerWait * 1000;
          }
        },
        getConfig: () => ({
          roundInterval: this.roundInterval / 1000,
          playerWait: this.playerWaitMs / 1000,
          maxPlayers: this.maxPlayers,
          npcCount: this.npcs.length,
          paused: this.paused,
          round: this.round,
        }),
        log: this.log,
      });
    }

    // Poll system
    if (config.llm) {
      const adminToken = config.adminToken ?? '';
      this.pollSystem = new PollSystem({
        llm: config.llm,
        resolveToken: (token) => this.resolvePlayerToken(token),
        isAdmin: (token) => !!adminToken && token === adminToken,
        getAgentName: (id) => this.getAgentName(id),
        broadcast: (event) => {
          this.broadcast({ type: 'event', event: event.type, data: event.data });
          this.httpApi?.pushEvent(event);
        },
        worldContext: this.worldContext,
        log: this.log,
      });
    }
  }

  async start(port: number, host: string = 'localhost'): Promise<void> {
    // Spawn NPCs
    if (this.npcRuntime && this.npcs.length > 0) {
      this.log(`Spawning ${this.npcs.length} NPCs via ${this.npcRuntime.name}...`);
      for (const npc of this.npcs) {
        const { sessionId } = await this.npcRuntime.spawn(npc, this.worldContext);
        this.npcSessionIds.set(npc.id, sessionId);
      }
      this.log(`${this.npcSessionIds.size} NPCs ready.`);
    }

    // Create HTTP server (handles both REST API and WebSocket upgrade)
    this.httpApi = new HttpApi({
      platform: this.platform,
      registerPlayer: (name, persona) => this.platform.registerPlayer(name, persona),
      getNpcs: () => this.npcs,
      getWorldContext: () => this.worldContext,
      getState: () => this.getState(),
      getAgents: () => {
        const npcsWithType = this.npcs.map(n => ({ ...n, type: 'npc' as const }));
        const wsPlayers = [...this.players.values()].map(p => ({
          id: p.id, username: p.name, role: 'player', personality: '', type: 'player' as const,
        }));
        const httpPlayers = [...this.httpApi!.getPlayers().values()].map(p => ({
          id: p.id, username: p.name, role: 'player', personality: '', type: 'player' as const,
        }));
        return [...npcsWithType, ...wsPlayers, ...httpPlayers];
      },
      onVote: this.pollSystem
        ? (agentId, pollId, optionIndex) => this.pollSystem!.vote(agentId, pollId, optionIndex)
        : undefined,
      maxPlayers: this.maxPlayers,
      log: this.log,
    });

    this.httpServer = createHttpServer(async (req, res) => {
      // Discovery endpoint (handled before HttpApi)
      if (req.url === '/api/discover' && req.method === 'GET') {
        handleDiscover(req, res, {
          worldName: this.worldContext.split('\n')[1]?.replace(/^.*"(.+)".*$/, '$1') ?? 'WorldMind',
          port: this.listenPort,
          getNpcs: () => this.npcs.length,
          getPlayers: () => this.totalPlayerCount,
          getMaxPlayers: () => this.maxPlayers,
          getRound: () => this.round,
        }, this.startTime);
        return;
      }
      const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      // Admin API
      if (this.adminApi && reqUrl.pathname.startsWith('/api/admin/')) {
        await this.adminApi.handle(req, res, reqUrl);
        return;
      }

      // Poll API
      if (this.pollSystem && reqUrl.pathname.startsWith('/api/poll/')) {
        await this.pollSystem.handle(req, res, reqUrl);
        return;
      }

      const handled = await this.httpApi!.handle(req, res);
      if (!handled) {
        // Serve static UI for non-API routes
        if (this.serveStatic(req, res, reqUrl)) return;

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found', endpoints: ['/api/discover', '/api/join', '/api/action', '/api/poll/*', '/api/admin/*', '/api/feed', '/api/notifications', '/api/state', '/api/agents', '/api/leave'] }));
      }
    });

    // WebSocket server attached to HTTP server (shared port)
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws, req) => {
      const origin = req.headers.origin ?? req.socket.remoteAddress ?? 'unknown';
      this.log(`Connection from ${origin} (${this.totalPlayerCount}/${this.maxPlayers})`);
      this.handleConnection(ws);
    });

    // Start listening
    this.listenPort = port;
    this.startTime = Date.now();
    await new Promise<void>((resolve) => {
      this.httpServer!.listen(port, host, () => resolve());
    });

    this.log(`🌍 WorldMind Server ws+http://${host}:${port}`);
    this.log(`   NPCs: ${this.npcs.length} | Max players: ${this.maxPlayers}`);
    this.log(`   HTTP API: http://${host}:${port}/api/{join,action,poll,feed,state,...}`);

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
    this.httpApi?.pushEvent({ type: 'server_shutdown', data: {} });
    this.wss?.close();
    this.httpServer?.close();
    await this.platform.shutdown();
    this.log('Server stopped.');
  }

  /** Trigger a round (called by timer or externally) */
  async runRound(): Promise<void> {
    this.round++;
    this.log(`\n─── Round ${this.round} ───`);

    // 1. Push round_start to all players (WS + HTTP) with their feed
    for (const [ws, player] of this.players) {
      try {
        const feed = await this.platform.queryFeed(player.id, 10);
        const notifs = await this.platform.queryNotifications(player.id, 5);
        this.send(ws, { type: 'round_start', round: this.round, feed, notifications: notifs });
      } catch (e) {
        this.log(`Feed error for ${player.name}: ${e}`);
      }
    }
    // HTTP players get round_start via poll
    if (this.httpApi) {
      for (const [, hp] of this.httpApi.getPlayers()) {
        try {
          const feed = await this.platform.queryFeed(hp.id, 10);
          const notifs = await this.platform.queryNotifications(hp.id, 5);
          this.httpApi.pushEventToPlayer(hp.id, {
            type: 'round_start',
            data: { round: this.round, feed, notifications: notifs },
          });
        } catch (e) {
          this.log(`[HTTP] Feed error for ${hp.name}: ${e}`);
        }
      }
    }

    // 2. NPC decisions + player wait run IN PARALLEL
    //    Players receive round_start above and start thinking.
    //    NPC LLM call takes ~5-15s. Player wait runs concurrently.
    //    After both finish, we collect all actions.

    const npcPromise = (async (): Promise<Decision[]> => {
      const decisions: Decision[] = [];
      if (this.npcRuntime && this.npcSessionIds.size > 0) {
        // Inject active poll context for NPC awareness
        if (this.pollSystem && 'pollContext' in this.npcRuntime) {
          (this.npcRuntime as DirectorNpcRuntime).pollContext = this.pollSystem.getPollSummaryForNpc();
        }
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
          decisions.push(...batch);
        } else {
          for (const [agentId, sessionId] of activeIds) {
            const feed = await this.platform.queryFeed(agentId, 10);
            const notifs = await this.platform.queryNotifications(agentId, 5);
            const d = await this.npcRuntime.decide(sessionId, { round: this.round, feed, notifications: notifs });
            decisions.push(d);
          }
        }
      }
      return decisions;
    })();

    const playerWaitPromise = (async () => {
      const totalPlayers = this.totalPlayerCount;
      if (totalPlayers > 0) {
        const waitMs = this.playerWaitMs;
        const deadline = Date.now() + waitMs;
        this.log(`  Waiting up to ${waitMs / 1000}s for player actions (${totalPlayers} players)...`);
        while (Date.now() < deadline) {
          // Check WS players
          let allSubmitted = true;
          for (const [, p] of this.players) {
            if (!p.pendingAction) { allSubmitted = false; break; }
          }
          // Check HTTP players
          if (allSubmitted && this.httpApi && this.httpApi.playerCount > 0) {
            if (!this.httpApi.allSubmitted()) allSubmitted = false;
          }
          if (allSubmitted) {
            this.log(`  All players submitted early`);
            break;
          }
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    })();

    // Wait for both NPC decisions and player actions
    const [npcDecisions] = await Promise.all([npcPromise, playerWaitPromise]);

    const playerDecisions: Decision[] = [];
    // WS players
    for (const [, player] of this.players) {
      if (player.pendingAction) {
        // Skip muted players
        if (this.adminApi?.isMuted(player.id)) {
          this.log(`  Skipping muted player ${player.name}`);
          player.pendingAction = null;
          continue;
        }
        // Handle vote actions via poll system
        if (player.pendingAction.action === 'vote' && this.pollSystem && player.pendingAction.pollId) {
          this.pollSystem.vote(player.id, player.pendingAction.pollId, player.pendingAction.optionIndex ?? 0);
          player.pendingAction = null;
          continue;
        }
        playerDecisions.push(player.pendingAction);
        player.pendingAction = null;
      }
    }
    // HTTP players
    if (this.httpApi) {
      const httpActions = this.httpApi.collectActions();
      for (const action of httpActions) {
        if (this.adminApi?.isMuted(action.agentId)) continue;
        if (action.action === 'vote' && this.pollSystem && action.pollId) {
          this.pollSystem.vote(action.agentId, action.pollId, action.optionIndex ?? 0);
          continue;
        }
        playerDecisions.push(action);
      }
    }

    // Handle NPC vote actions via poll system
    const npcNonVoteDecisions = npcDecisions.filter(d => {
      if (d.action === 'vote' && this.pollSystem && d.pollId) {
        this.pollSystem.vote(d.agentId, d.pollId, d.optionIndex ?? 0);
        return false;
      }
      return true;
    });

    // 4. Execute all
    const all = [...npcNonVoteDecisions, ...playerDecisions].filter(d => d.action !== 'do_nothing');
    if (all.length > 0) {
      await this.platform.executeBatch(all);
    }

    // 5. Broadcast round_end
    const state = this.getState();
    for (const [ws] of this.players) {
      this.send(ws, { type: 'round_end', round: this.round, state });
    }
    // HTTP players
    this.httpApi?.pushEvent({ type: 'round_end', data: { round: this.round, state } });

    // Tick poll and mute systems
    this.pollSystem?.tickRound();
    this.adminApi?.tickMutes();

    const httpCount = this.httpApi?.playerCount ?? 0;
    this.log(`Round ${this.round}: ${npcDecisions.length} NPC + ${playerDecisions.length} player actions (${this.players.size} WS + ${httpCount} HTTP)`);
  }

  get playerCount(): number { return this.players.size; }
  get totalPlayerCount(): number { return this.players.size + (this.httpApi?.playerCount ?? 0); }

  // ─── Admin / Poll helpers ─────────────────────────────────────

  /** Kick a player by id from WS or HTTP */
  private kickPlayer(playerId: number): boolean {
    // WS players
    for (const [ws, p] of this.players) {
      if (p.id === playerId) {
        this.send(ws, { type: 'event', event: 'kicked', data: { reason: 'Kicked by admin' } });
        ws.close();
        this.players.delete(ws);
        this.log(`Kicked WS player: ${p.name} (#${p.id})`);
        return true;
      }
    }
    // HTTP players
    if (this.httpApi) {
      for (const [token, hp] of this.httpApi.getPlayers()) {
        if (hp.id === playerId) {
          this.httpApi.getPlayers().delete(token);
          this.log(`Kicked HTTP player: ${hp.name} (#${hp.id})`);
          return true;
        }
      }
    }
    return false;
  }

  /** List all connected players with mute info */
  private listAllPlayers(): Array<{ id: number; name: string; type: 'ws' | 'http'; joinedAt: number; muted: boolean; muteRoundsLeft: number }> {
    const list: Array<{ id: number; name: string; type: 'ws' | 'http'; joinedAt: number; muted: boolean; muteRoundsLeft: number }> = [];
    for (const [, p] of this.players) {
      const mute = this.adminApi?.getMuteInfo(p.id) ?? { muted: false, roundsLeft: 0 };
      list.push({ id: p.id, name: p.name, type: 'ws', joinedAt: p.joinedAt, muted: mute.muted, muteRoundsLeft: mute.roundsLeft });
    }
    if (this.httpApi) {
      for (const [, hp] of this.httpApi.getPlayers()) {
        const mute = this.adminApi?.getMuteInfo(hp.id) ?? { muted: false, roundsLeft: 0 };
        list.push({ id: hp.id, name: hp.name, type: 'http', joinedAt: hp.joinedAt, muted: mute.muted, muteRoundsLeft: mute.roundsLeft });
      }
    }
    return list;
  }

  /** Broadcast a system message to all players */
  private broadcastSystemMessage(message: string): void {
    const event = { type: 'event', event: 'system_broadcast', data: { message } } as const;
    this.broadcast(event);
    this.httpApi?.pushEvent({ type: 'system_broadcast', data: { message } });
  }

  /** Resolve HTTP player token → { id, name } */
  private resolvePlayerToken(token: string): { id: number; name: string } | null {
    if (!this.httpApi) return null;
    const player = this.httpApi.getPlayers().get(token);
    if (player) return { id: player.id, name: player.name };
    return null;
  }

  /** Get display name for any agent (NPC or player) */
  private getAgentName(id: number): string {
    // NPC
    const npc = this.npcs.find(n => n.id === id);
    if (npc) return npc.username;
    // WS player
    for (const [, p] of this.players) {
      if (p.id === id) return p.name;
    }
    // HTTP player
    if (this.httpApi) {
      for (const [, hp] of this.httpApi.getPlayers()) {
        if (hp.id === id) return hp.name;
      }
    }
    return `agent_${id}`;
  }

  /** Inject a system event as a post (uses NPC agent 0 if no author specified) */
  private async injectSystemEvent(content: string, author?: string): Promise<void> {
    // Find author agent id
    let agentId = 0; // default: first NPC
    if (author) {
      const npc = this.npcs.find(n => n.username.toLowerCase() === author.toLowerCase());
      if (npc) agentId = npc.id;
    }

    const prefixed = author ? content : `📢 [系统事件] ${content}`;
    await this.platform.executeBatch([{ agentId, action: 'post', content: prefixed }]);

    // Broadcast to all players
    this.broadcastSystemMessage(prefixed);
  }

  /** Get poll system (exposed for serve.ts to pass to NPC runtime) */
  getPollSystem(): PollSystem | null { return this.pollSystem; }

  /** Serve static files from multiplayer/public */
  private serveStatic(_req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    let filePath = url.pathname;
    if (filePath === '/') filePath = '/index.html';

    // Only serve index.html for now (single-page app)
    if (filePath !== '/index.html') return false;

    // Find public dir relative to this file
    const publicDir = pathJoin(import.meta.dirname ?? '.', '../public');
    const fullPath = pathJoin(publicDir, 'index.html');

    if (!existsSync(fullPath)) return false;

    try {
      const content = readFileSync(fullPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
      return true;
    } catch {
      return false;
    }
  }

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
        if (this.totalPlayerCount >= this.maxPlayers) {
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

        // Mute check
        if (this.adminApi?.isMuted(p.id) && msg.action !== 'do_nothing') {
          this.send(ws, { type: 'action_ack', success: false, message: 'You are muted' });
          return;
        }

        // Vote action — handle immediately via poll system
        if (msg.action === 'vote' && this.pollSystem && msg.pollId) {
          const result = this.pollSystem.vote(p.id, msg.pollId, msg.optionIndex ?? 0);
          this.send(ws, { type: 'action_ack', success: result.success, message: result.error });
          return;
        }

        p.pendingAction = {
          agentId: p.id,
          action: msg.action,
          content: msg.content,
          targetPostId: msg.targetPostId,
          targetUserId: msg.targetUserId,
          groupId: msg.groupId,
          groupName: msg.groupName,
          pollId: msg.pollId,
          optionIndex: msg.optionIndex,
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
        const wsPlayers = [...this.players.values()].map(p => ({
          id: p.id, username: p.name, role: 'player', personality: '', type: 'player' as const,
        }));
        const httpPlayers = [...(this.httpApi?.getPlayers().values() ?? [])].map(p => ({
          id: p.id, username: p.name, role: 'player', personality: '', type: 'player' as const,
        }));
        this.send(ws, { type: 'agents_result', agents: [...npcsWithType, ...wsPlayers, ...httpPlayers] });
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
    return { ...s, round: this.round, totalPlayers: this.totalPlayerCount };
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

/**
 * HTTP REST API layer for WorldMind server.
 *
 * Enables remote OpenClaw agents (or any HTTP client) to join as players
 * without needing WebSocket. Runs on the same port as the WS server.
 *
 * API Design:
 *   POST /join          → { name, persona? }         → { token, playerId, worldContext, npcs }
 *   POST /action        → { token, action, ... }     → { success }
 *   GET  /poll?token=   → long-poll for events       → { events: [...] }
 *   GET  /feed?token=   → latest feed                → { feed: [...] }
 *   GET  /state         → world state                → { state: {...} }
 *   GET  /notifications?token= → notifications       → { notifications: [...] }
 *   GET  /agents        → all agents                 → { agents: [...] }
 *   POST /leave         → { token }                  → { success }
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type {
  Decision,
  FeedItem,
  Notification,
  Persona,
  PlatformAdapter,
  WorldState,
} from './types.js';
import { randomBytes } from 'crypto';

// ─── HTTP Player ────────────────────────────────────────────────

interface HttpPlayer {
  token: string;
  id: number;
  name: string;
  pendingAction: Decision | null;
  events: Array<{ type: string; data: unknown; ts: number }>;
  /** Pending long-poll response waiting to be flushed */
  pendingPoll: ServerResponse | null;
  joinedAt: number;
}

// ─── HTTP API Handler ───────────────────────────────────────────

export interface HttpApiDeps {
  platform: PlatformAdapter;
  /** Register player in the main server (allocates slot) */
  registerPlayer: (name: string, persona?: { role: string; personality: string }) => Promise<number>;
  /** Get NPC personas */
  getNpcs: () => Persona[];
  /** Get world context */
  getWorldContext: () => string;
  /** Get current state */
  getState: () => WorldState;
  /** Get all agents info */
  getAgents: () => Array<Persona & { type: 'npc' | 'player' }>;
  /** Max HTTP players */
  maxPlayers: number;
  /** Log */
  log: (msg: string) => void;
}

export class HttpApi {
  private players = new Map<string, HttpPlayer>(); // token → player
  private deps: HttpApiDeps;

  constructor(deps: HttpApiDeps) {
    this.deps = deps;
  }

  /** Get all HTTP players (for server to check pending actions) */
  getPlayers(): Map<string, HttpPlayer> { return this.players; }

  /** Get player count */
  get playerCount(): number { return this.players.size; }

  /** Push an event to all HTTP players (called by server on round_start, round_end, etc.) */
  pushEvent(event: { type: string; data: unknown }) {
    const entry = { ...event, ts: Date.now() };
    for (const [, player] of this.players) {
      player.events.push(entry);
      // Flush pending long-poll if any
      if (player.pendingPoll) {
        this.flushPoll(player);
      }
    }
  }

  /** Push event to a specific player by id */
  pushEventToPlayer(playerId: number, event: { type: string; data: unknown }) {
    for (const [, player] of this.players) {
      if (player.id === playerId) {
        const entry = { ...event, ts: Date.now() };
        player.events.push(entry);
        if (player.pendingPoll) this.flushPoll(player);
        break;
      }
    }
  }

  /** Check if all HTTP players have submitted actions */
  allSubmitted(): boolean {
    for (const [, p] of this.players) {
      if (!p.pendingAction) return false;
    }
    return true;
  }

  /** Collect and clear pending actions */
  collectActions(): Decision[] {
    const decisions: Decision[] = [];
    for (const [, p] of this.players) {
      if (p.pendingAction) {
        decisions.push(p.pendingAction);
        p.pendingAction = null;
      }
    }
    return decisions;
  }

  /** Handle HTTP request — returns true if handled, false if not an API route */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    // API routes
    if (path === '/api/join' && req.method === 'POST') return this.handleJoin(req, res);
    if (path === '/api/action' && req.method === 'POST') return this.handleAction(req, res);
    if (path === '/api/poll' && req.method === 'GET') return this.handlePoll(url, res);
    if (path === '/api/feed' && req.method === 'GET') return this.handleFeed(url, res);
    if (path === '/api/notifications' && req.method === 'GET') return this.handleNotifications(url, res);
    if (path === '/api/state' && req.method === 'GET') return this.handleState(res);
    if (path === '/api/agents' && req.method === 'GET') return this.handleAgents(res);
    if (path === '/api/leave' && req.method === 'POST') return this.handleLeave(req, res);

    return false; // Not an API route
  }

  // ─── Route Handlers ─────────────────────────────────────────

  private async handleJoin(req: IncomingMessage, res: ServerResponse): Promise<true> {
    const body = await readBody(req);
    if (!body.name) return this.json(res, 400, { error: 'name required' });

    if (this.players.size >= this.deps.maxPlayers) {
      return this.json(res, 503, { error: 'server full' });
    }

    const token = randomBytes(16).toString('hex');
    const playerId = await this.deps.registerPlayer(body.name, body.persona);

    const player: HttpPlayer = {
      token,
      id: playerId,
      name: body.name,
      pendingAction: null,
      events: [],
      pendingPoll: null,
      joinedAt: Date.now(),
    };
    this.players.set(token, player);

    this.deps.log(`[HTTP] Player joined: ${body.name} (#${playerId})`);

    return this.json(res, 200, {
      token,
      playerId,
      worldContext: this.deps.getWorldContext(),
      npcs: this.deps.getNpcs(),
    });
  }

  private async handleAction(req: IncomingMessage, res: ServerResponse): Promise<true> {
    const body = await readBody(req);
    const player = this.getPlayerFromBody(body, res);
    if (!player) return true;

    player.pendingAction = {
      agentId: player.id,
      action: body.action,
      content: body.content,
      targetPostId: body.targetPostId,
      targetUserId: body.targetUserId,
      groupId: body.groupId,
      groupName: body.groupName,
    };

    this.deps.log(`[HTTP] Action from ${player.name}: ${body.action}`);
    return this.json(res, 200, { success: true });
  }

  private async handlePoll(url: URL, res: ServerResponse): Promise<true> {
    const token = url.searchParams.get('token');
    if (!token) return this.json(res, 400, { error: 'token required' });

    const player = this.players.get(token);
    if (!player) return this.json(res, 404, { error: 'unknown token' });

    // If there are buffered events, return immediately
    if (player.events.length > 0) {
      const events = [...player.events];
      player.events = [];
      return this.json(res, 200, { events });
    }

    // Long-poll: hold the connection up to 30s
    const timeout = parseInt(url.searchParams.get('timeout') ?? '30000');
    player.pendingPoll = res;

    const timer = setTimeout(() => {
      if (player.pendingPoll === res) {
        player.pendingPoll = null;
        this.json(res, 200, { events: [] });
      }
    }, Math.min(timeout, 60000));

    // Clean up if client disconnects
    res.on('close', () => {
      clearTimeout(timer);
      if (player.pendingPoll === res) player.pendingPoll = null;
    });

    return true;
  }

  private async handleFeed(url: URL, res: ServerResponse): Promise<true> {
    const player = this.getPlayerFromQuery(url, res);
    if (!player) return true;

    const limit = parseInt(url.searchParams.get('limit') ?? '10');
    const feed = await this.deps.platform.queryFeed(player.id, limit);
    return this.json(res, 200, { feed });
  }

  private async handleNotifications(url: URL, res: ServerResponse): Promise<true> {
    const player = this.getPlayerFromQuery(url, res);
    if (!player) return true;

    const limit = parseInt(url.searchParams.get('limit') ?? '5');
    const notifications = await this.deps.platform.queryNotifications(player.id, limit);
    return this.json(res, 200, { notifications });
  }

  private async handleState(res: ServerResponse): Promise<true> {
    return this.json(res, 200, { state: this.deps.getState() });
  }

  private async handleAgents(res: ServerResponse): Promise<true> {
    return this.json(res, 200, { agents: this.deps.getAgents() });
  }

  private async handleLeave(req: IncomingMessage, res: ServerResponse): Promise<true> {
    const body = await readBody(req);
    const player = this.getPlayerFromBody(body, res);
    if (!player) return true;

    this.deps.log(`[HTTP] Player left: ${player.name}`);
    this.players.delete(player.token);
    return this.json(res, 200, { success: true });
  }

  // ─── Helpers ────────────────────────────────────────────────

  private getPlayerFromBody(body: any, res: ServerResponse): HttpPlayer | null {
    const token = body.token;
    if (!token) { this.json(res, 400, { error: 'token required' }); return null; }
    const player = this.players.get(token);
    if (!player) { this.json(res, 404, { error: 'unknown token' }); return null; }
    return player;
  }

  private getPlayerFromQuery(url: URL, res: ServerResponse): HttpPlayer | null {
    const token = url.searchParams.get('token');
    if (!token) { this.json(res, 400, { error: 'token required' }); return null; }
    const player = this.players.get(token);
    if (!player) { this.json(res, 404, { error: 'unknown token' }); return null; }
    return player;
  }

  private flushPoll(player: HttpPlayer) {
    const res = player.pendingPoll;
    if (!res) return;
    player.pendingPoll = null;
    const events = [...player.events];
    player.events = [];
    this.json(res, 200, { events });
  }

  private json(res: ServerResponse, status: number, data: unknown): true {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return true;
  }
}

// ─── Utils ──────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

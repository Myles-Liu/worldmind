/**
 * WorldMind Admin API
 *
 * Provides admin-only endpoints for server management:
 *   POST /api/admin/kick       { adminToken, playerId }
 *   POST /api/admin/mute       { adminToken, playerId, rounds }
 *   POST /api/admin/unmute     { adminToken, playerId }
 *   POST /api/admin/broadcast  { adminToken, message }
 *   POST /api/admin/pause      { adminToken }
 *   POST /api/admin/resume     { adminToken }
 *   POST /api/admin/round      { adminToken }  — trigger one round manually
 *   POST /api/admin/inject     { adminToken, content, author? }  — inject system event/news
 *   GET  /api/admin/players    ?adminToken=
 *   POST /api/admin/config     { adminToken, roundInterval?, playerWait? }
 */

import type { IncomingMessage, ServerResponse } from 'http';

// ─── Types ──────────────────────────────────────────────────────

export interface MuteEntry {
  playerId: number;
  remainingRounds: number; // -1 = permanent until unmute
}

export interface AdminDeps {
  adminToken: string;

  /** Kick a player by id (WS + HTTP) */
  kickPlayer: (playerId: number) => boolean;

  /** Get all connected players */
  getPlayers: () => Array<{
    id: number;
    name: string;
    type: 'ws' | 'http';
    joinedAt: number;
    muted: boolean;
    muteRoundsLeft: number;
  }>;

  /** Broadcast a system message to all players */
  broadcast: (message: string) => void;

  /** Pause auto-rounds */
  pause: () => boolean;

  /** Resume auto-rounds */
  resume: () => boolean;

  /** Trigger one round manually */
  triggerRound: () => Promise<void>;

  /** Whether auto-rounds are currently paused */
  isPaused: () => boolean;

  /** Inject a system event as a post into the world */
  injectEvent: (content: string, author?: string) => Promise<void>;

  /** Update runtime config */
  updateConfig: (patch: { roundInterval?: number; playerWait?: number }) => void;

  /** Get current config */
  getConfig: () => { roundInterval: number; playerWait: number; maxPlayers: number; npcCount: number; paused: boolean; round: number };

  log: (msg: string) => void;
}

// ─── Admin API ──────────────────────────────────────────────────

export class AdminApi {
  private deps: AdminDeps;
  private mutedPlayers = new Map<number, MuteEntry>();

  constructor(deps: AdminDeps) {
    this.deps = deps;
  }

  /** Check if a player is muted */
  isMuted(playerId: number): boolean {
    return this.mutedPlayers.has(playerId);
  }

  /** Tick mute counters down after each round */
  tickMutes(): void {
    for (const [id, entry] of this.mutedPlayers) {
      if (entry.remainingRounds > 0) {
        entry.remainingRounds--;
        if (entry.remainingRounds === 0) {
          this.mutedPlayers.delete(id);
          this.deps.log(`[admin] Player #${id} unmuted (expired)`);
        }
      }
      // -1 = permanent, stays
    }
  }

  /** Get mute info for a player */
  getMuteInfo(playerId: number): { muted: boolean; roundsLeft: number } {
    const entry = this.mutedPlayers.get(playerId);
    if (!entry) return { muted: false, roundsLeft: 0 };
    return { muted: true, roundsLeft: entry.remainingRounds };
  }

  /** Handle admin HTTP request — returns true if handled */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;

    if (!path.startsWith('/api/admin/')) return false;

    // Verify admin token
    const route = path.slice('/api/admin/'.length);

    if (route === 'players' && req.method === 'GET') {
      if (!this.checkAuth(url.searchParams.get('adminToken'), res)) return true;
      return this.handlePlayers(res);
    }

    if (req.method !== 'POST') {
      return this.json(res, 405, { error: 'POST required' });
    }

    const body = await readBody(req);

    if (!this.checkAuth(body.adminToken, res)) return true;

    switch (route) {
      case 'kick': return this.handleKick(body, res);
      case 'mute': return this.handleMute(body, res);
      case 'unmute': return this.handleUnmute(body, res);
      case 'broadcast': return this.handleBroadcast(body, res);
      case 'pause': return this.handlePause(res);
      case 'resume': return this.handleResume(res);
      case 'round': return this.handleTriggerRound(res);
      case 'inject': return this.handleInject(body, res);
      case 'config': return this.handleConfig(body, res);
      default: return this.json(res, 404, { error: `unknown admin route: ${route}` });
    }
  }

  // ─── Route Handlers ─────────────────────────────────────────

  private handleKick(body: any, res: ServerResponse): true {
    const { playerId } = body;
    if (typeof playerId !== 'number') return this.json(res, 400, { error: 'playerId required (number)' });

    const kicked = this.deps.kickPlayer(playerId);
    if (kicked) {
      this.mutedPlayers.delete(playerId); // clean up mute if any
      this.deps.log(`[admin] Kicked player #${playerId}`);
    }
    return this.json(res, 200, { success: kicked, playerId });
  }

  private handleMute(body: any, res: ServerResponse): true {
    const { playerId, rounds } = body;
    if (typeof playerId !== 'number') return this.json(res, 400, { error: 'playerId required (number)' });

    const muteRounds = typeof rounds === 'number' ? rounds : -1;
    this.mutedPlayers.set(playerId, { playerId, remainingRounds: muteRounds });
    this.deps.log(`[admin] Muted player #${playerId} for ${muteRounds === -1 ? '∞' : muteRounds} rounds`);
    return this.json(res, 200, { success: true, playerId, rounds: muteRounds });
  }

  private handleUnmute(body: any, res: ServerResponse): true {
    const { playerId } = body;
    if (typeof playerId !== 'number') return this.json(res, 400, { error: 'playerId required (number)' });

    const was = this.mutedPlayers.delete(playerId);
    this.deps.log(`[admin] Unmuted player #${playerId} (was muted: ${was})`);
    return this.json(res, 200, { success: true, playerId });
  }

  private handleBroadcast(body: any, res: ServerResponse): true {
    const { message } = body;
    if (!message || typeof message !== 'string') return this.json(res, 400, { error: 'message required (string)' });

    this.deps.broadcast(message);
    this.deps.log(`[admin] Broadcast: ${message.slice(0, 80)}`);
    return this.json(res, 200, { success: true });
  }

  private handlePause(res: ServerResponse): true {
    const paused = this.deps.pause();
    if (paused) {
      this.deps.log('[admin] Auto-rounds paused');
      this.deps.broadcast('⏸️ 世界已暂停');
    }
    return this.json(res, 200, { success: true, paused: this.deps.isPaused() });
  }

  private handleResume(res: ServerResponse): true {
    const resumed = this.deps.resume();
    if (resumed) {
      this.deps.log('[admin] Auto-rounds resumed');
      this.deps.broadcast('▶️ 世界已恢复');
    }
    return this.json(res, 200, { success: true, paused: this.deps.isPaused() });
  }

  private async handleTriggerRound(res: ServerResponse): Promise<true> {
    this.deps.log('[admin] Manual round triggered');
    // Don't await — trigger async so response returns immediately
    this.deps.triggerRound().catch(e => this.deps.log(`[admin] Manual round error: ${e}`));
    return this.json(res, 200, { success: true, message: 'Round triggered' });
  }

  private async handleInject(body: any, res: ServerResponse): Promise<true> {
    const { content, author } = body;
    if (!content || typeof content !== 'string') return this.json(res, 400, { error: 'content required (string)' });

    await this.deps.injectEvent(content, author);
    this.deps.log(`[admin] Injected event: "${content.slice(0, 80)}"${author ? ` as ${author}` : ''}`);
    return this.json(res, 200, { success: true });
  }

  private handlePlayers(res: ServerResponse): true {
    return this.json(res, 200, { players: this.deps.getPlayers() });
  }

  private handleConfig(body: any, res: ServerResponse): true {
    const patch: { roundInterval?: number; playerWait?: number } = {};
    if (typeof body.roundInterval === 'number') patch.roundInterval = body.roundInterval;
    if (typeof body.playerWait === 'number') patch.playerWait = body.playerWait;

    if (Object.keys(patch).length === 0) {
      // Just return current config
      return this.json(res, 200, { config: this.deps.getConfig() });
    }

    this.deps.updateConfig(patch);
    this.deps.log(`[admin] Config updated: ${JSON.stringify(patch)}`);
    return this.json(res, 200, { success: true, config: this.deps.getConfig() });
  }

  // ─── Helpers ────────────────────────────────────────────────

  private checkAuth(token: string | null | undefined, res: ServerResponse): boolean {
    if (!token || token !== this.deps.adminToken) {
      this.json(res, 403, { error: 'invalid admin token' });
      return false;
    }
    return true;
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
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

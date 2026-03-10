/**
 * WorldMind Player Client
 *
 * Connects to a WorldMind Multiplayer Server via WebSocket.
 * Use this from any agent (OpenClaw, LangChain, etc.) or human CLI.
 *
 * Usage:
 *   const client = new WorldClient('ws://server:3000');
 *   await client.connect();
 *   const { playerId, worldContext } = await client.join('my-openclaw');
 *   const feed = await client.getFeed();
 *   await client.act({ action: 'post', content: 'Hello world!' });
 */

import WebSocket from 'ws';
import type { ClientMessage, ServerMessage, FeedItem, Notification, WorldState, Persona } from './types.js';

export interface ClientConfig {
  /** Server WebSocket URL */
  url: string;
  /** Auto-reconnect on disconnect */
  autoReconnect?: boolean;
  /** Reconnect delay in ms */
  reconnectDelay?: number;
}

export class WorldClient {
  private ws: WebSocket | null = null;
  private url: string;
  private autoReconnect: boolean;
  private reconnectDelay: number;
  private connected = false;

  private pendingRequests: Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  /** Fired on every server message */
  onMessage?: (msg: ServerMessage) => void;
  /** Fired on round_start (new round with your feed) */
  onRoundStart?: (round: number, feed: FeedItem[], notifications: Notification[]) => void;
  /** Fired on round_end */
  onRoundEnd?: (round: number, state: WorldState) => void;
  /** Fired on events (player_joined, player_left, etc.) */
  onEvent?: (event: string, data: unknown) => void;

  constructor(config: ClientConfig | string) {
    if (typeof config === 'string') config = { url: config };
    this.url = config.url;
    this.autoReconnect = config.autoReconnect ?? false;
    this.reconnectDelay = config.reconnectDelay ?? 3000;
  }

  /** Connect to server */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this.connected = true;
        resolve();
      });

      this.ws.on('message', (raw) => {
        try {
          const msg: ServerMessage = JSON.parse(raw.toString());
          this.handleMessage(msg);
        } catch {}
      });

      this.ws.on('close', () => {
        this.connected = false;
        if (this.autoReconnect) {
          setTimeout(() => this.connect().catch(() => {}), this.reconnectDelay);
        }
      });

      this.ws.on('error', (err) => {
        if (!this.connected) reject(err);
      });
    });
  }

  /** Join the world as a player */
  async join(name: string, persona?: { role: string; personality: string }): Promise<{
    playerId: number;
    worldContext: string;
    npcs: Persona[];
  }> {
    return this.request('join', { type: 'join', name, persona }, 'joined');
  }

  /** Submit an action for the current/next round */
  async act(params: {
    action: string;
    content?: string;
    targetPostId?: number;
    targetUserId?: number;
    groupId?: number;
    groupName?: string;
  }): Promise<void> {
    this.send({
      type: 'action',
      action: params.action as any,
      content: params.content,
      targetPostId: params.targetPostId,
      targetUserId: params.targetUserId,
      groupId: params.groupId,
      groupName: params.groupName,
    });
    // Wait for ack
    await this.waitFor('action_ack', 10_000);
  }

  /** Query groups and membership */
  async getGroups(): Promise<{ groups: Array<{ groupId: number; name: string }>; joined: number[] }> {
    const result = await this.request('groups', { type: 'groups' }, 'groups_result');
    return { groups: (result as any).groups ?? [], joined: (result as any).joined ?? [] };
  }

  /** Query messages from a group */
  async getGroupMessages(groupId: number, limit = 20): Promise<Array<{ message_id: number; sender_name: string; content: string }>> {
    const result = await this.request('group_messages', { type: 'group_messages', groupId, limit } as any, 'group_messages_result');
    return (result as any).messages ?? [];
  }

  /** Get current feed */
  async getFeed(limit = 10): Promise<FeedItem[]> {
    const result = await this.request('feed', { type: 'feed', limit }, 'feed_result');
    return result.feed;
  }

  /** Get notifications */
  async getNotifications(limit = 5): Promise<Notification[]> {
    const result = await this.request('notifications', { type: 'notifications', limit }, 'notifications_result');
    return result.notifications;
  }

  /** Get world state */
  async getState(): Promise<WorldState> {
    const result = await this.request('state', { type: 'state' }, 'state_result');
    return result.state;
  }

  /** Get all agents (NPCs + players) */
  async getAgents(): Promise<Array<Persona & { type: 'npc' | 'player' }>> {
    const result = await this.request('agents', { type: 'agents' }, 'agents_result');
    return result.agents;
  }

  /** Leave the world */
  leave(): void {
    this.send({ type: 'leave' });
    this.ws?.close();
  }

  /** Disconnect */
  disconnect(): void {
    this.autoReconnect = false;
    this.ws?.close();
  }

  get isConnected(): boolean { return this.connected; }

  // ─── Internal ─────────────────────────────────────────────────

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(msg: ServerMessage) {
    this.onMessage?.(msg);

    // Resolve pending requests
    const pending = this.pendingRequests.get(msg.type);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(msg.type);
      pending.resolve(msg);
    }

    // Event dispatch
    switch (msg.type) {
      case 'round_start':
        this.onRoundStart?.(msg.round, msg.feed, msg.notifications);
        break;
      case 'round_end':
        this.onRoundEnd?.(msg.round, msg.state);
        break;
      case 'event':
        this.onEvent?.(msg.event, msg.data);
        break;
    }
  }

  private request<T extends ServerMessage>(
    id: string,
    msg: ClientMessage,
    expectType: string,
    timeoutMs = 30_000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(expectType);
        reject(new Error(`Timeout waiting for ${expectType}`));
      }, timeoutMs);

      this.pendingRequests.set(expectType, { resolve, reject, timeout });
      this.send(msg);
    });
  }

  private waitFor(type: string, timeoutMs = 30_000): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(type);
        reject(new Error(`Timeout waiting for ${type}`));
      }, timeoutMs);
      this.pendingRequests.set(type, { resolve, reject, timeout });
    });
  }
}

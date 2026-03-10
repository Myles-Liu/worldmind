/**
 * WorldMind Multiplayer — Shared types
 *
 * All types here are self-contained. No imports from ../../src.
 * This ensures multiplayer can be deployed independently.
 */

// ─── Agent / Player Identity ────────────────────────────────────

export interface Persona {
  id: number;
  username: string;       // handle (@thor)
  displayName?: string;   // display name (雷神索尔)
  role: string;
  personality: string;
}

// ─── Social Content ─────────────────────────────────────────────

export interface FeedItem {
  postId: number;
  authorId: number;
  authorName: string;
  content: string;
  likes: number;
  comments: number;
  createdAt?: string;
}

export interface Notification {
  type: string;       // 'comment' | 'follow' | 'like'
  fromAgent: string;
  content: string;
}

// ─── Actions ────────────────────────────────────────────────────

export type ActionType = 'post' | 'comment' | 'like' | 'follow' | 'repost' | 'quote'
  | 'create_group' | 'join_group' | 'leave_group' | 'send_to_group'
  | 'create_poll' | 'vote'
  | 'do_nothing';

export interface Decision {
  agentId: number;
  action: ActionType;
  content?: string;
  targetPostId?: number;
  targetUserId?: number;
  groupId?: number;
  groupName?: string;
  pollId?: string;
  optionIndex?: number;
  reasoning?: string;
}

// ─── World State ────────────────────────────────────────────────

export interface WorldState {
  round: number;
  totalAgents: number;
  totalPlayers: number;
  totalPosts: number;
  totalComments: number;
  totalLikes: number;
  totalFollows: number;
}

// ─── Player Protocol (WebSocket JSON messages) ──────────────────

/** Client → Server */
export type ClientMessage =
  | { type: 'join'; name: string; persona?: { role: string; personality: string } }
  | { type: 'action'; action: ActionType; content?: string; targetPostId?: number; targetUserId?: number; groupId?: number; groupName?: string; pollId?: string; optionIndex?: number }
  | { type: 'feed'; limit?: number }
  | { type: 'notifications'; limit?: number }
  | { type: 'groups' }
  | { type: 'group_messages'; groupId: number; limit?: number }
  | { type: 'state' }
  | { type: 'agents' }
  | { type: 'leave' };

/** Server → Client */
export type ServerMessage =
  | { type: 'joined'; playerId: number; worldContext: string; npcs: Persona[] }
  | { type: 'round_start'; round: number; feed: FeedItem[]; notifications: Notification[] }
  | { type: 'round_end'; round: number; state: WorldState }
  | { type: 'action_ack'; success: boolean; message?: string }
  | { type: 'feed_result'; feed: FeedItem[] }
  | { type: 'notifications_result'; notifications: Notification[] }
  | { type: 'state_result'; state: WorldState }
  | { type: 'agents_result'; agents: Array<Persona & { type: 'npc' | 'player' }> }
  | { type: 'event'; event: string; data: unknown }
  | { type: 'error'; message: string };

// ─── Platform Adapter ───────────────────────────────────────────

/**
 * Abstraction over the social platform (OASIS, or any future backend).
 * The server only talks to this interface — never directly to OASIS.
 */
export interface PlatformAdapter {
  /** Query global or agent-specific feed */
  queryFeed(agentId: number, limit: number): Promise<FeedItem[]>;

  /** Query notifications for an agent */
  queryNotifications(agentId: number, limit: number): Promise<Notification[]>;

  /** Query groups and agent's membership */
  queryGroups(agentId: number): Promise<{ groups: Array<{ groupId: number; name: string }>; joined: number[] }>;

  /** Query messages from a specific group */
  queryGroupMessages(groupId: number, limit?: number): Promise<Array<{ message_id: number; sender_name: string; content: string }>>;

  /** Execute a batch of decisions */
  executeBatch(decisions: Decision[]): Promise<{ executed: number; skipped: number }>;

  /** Get current world state */
  getState(): WorldState;

  /** Get all registered agents */
  getAgents(): Persona[];

  /** Register a new player in the platform */
  registerPlayer(name: string, persona?: { role: string; personality: string }): Promise<number>;

  /** Shutdown the platform */
  shutdown(): Promise<void>;
}

// ─── NPC Runtime ────────────────────────────────────────────────

/**
 * Drives NPC agents. Same concept as AgentRuntime in src/player,
 * but self-contained — no import dependency.
 */
export interface NpcRuntime {
  readonly name: string;
  spawn(persona: Persona, worldContext: string): Promise<{ sessionId: string }>;
  decide(sessionId: string, context: {
    round: number;
    feed: FeedItem[];
    notifications: Notification[];
  }): Promise<Decision>;
  decideBatch?(sessionIds: string[], contexts: Map<string, {
    round: number;
    feed: FeedItem[];
    notifications: Notification[];
  }>): Promise<Decision[]>;
  shutdownAll(): Promise<void>;
}

/**
 * WorldMind Interactive Types
 *
 * Two roles:
 * - Player: first-person participant in the simulation
 * - Admin: god-mode observer/manipulator of the simulation
 */

// ─── Roles ──────────────────────────────────────────────────────

export type Role = 'player' | 'admin';

// ─── Agent & World ──────────────────────────────────────────────

export interface AgentProfile {
  id: number;
  username: string;
  displayName: string;
  bio: string;
  followers: number;
  following: number;
  isPlayer: boolean;
}

export interface Post {
  id: number;
  authorId: number;
  authorName: string;
  content: string;
  likes: number;
  comments: number;
  reposts: number;
  createdAt: string;
  isPlayer: boolean;
}

export interface Comment {
  id: number;
  postId: number;
  authorId: number;
  authorName: string;
  content: string;
  createdAt: string;
  isPlayer: boolean;
}

export interface Notification {
  type: 'like' | 'comment' | 'follow' | 'repost' | 'mention';
  fromAgent: string;
  content: string;
  timestamp: string;
}

export interface WorldState {
  round: number;
  totalRounds: number;
  totalAgents: number;
  totalPosts: number;
  totalComments: number;
  totalLikes: number;
  totalFollows: number;
  // Player-specific (only when role=player)
  player?: {
    id: number;
    followers: number;
    following: number;
    posts: number;
  };
  notifications: Notification[];
}

// ─── Actions ────────────────────────────────────────────────────

/** Player actions — things a participant in the world can do */
export type PlayerAction =
  | { type: 'post'; content: string }
  | { type: 'comment'; postId: number; content: string }
  | { type: 'like'; postId: number }
  | { type: 'follow'; userId: number }
  | { type: 'feed'; limit?: number }
  | { type: 'notifications' }
  | { type: 'profile'; userId?: number }
  | { type: 'wait' };  // skip turn, let agents act

/** Admin actions — god-mode operations */
export type AdminAction =
  | { type: 'inject_event'; content: string; asAgent?: number }  // force a post from an agent
  | { type: 'inject_news'; headline: string }  // broadcast breaking news
  | { type: 'kill_agent'; agentId: number }  // remove an agent
  | { type: 'spawn_agent'; profile: Omit<AgentProfile, 'id' | 'isPlayer' | 'followers' | 'following'> }
  | { type: 'mutate_agent'; agentId: number; newBio: string }  // change agent personality
  | { type: 'status' }  // world overview
  | { type: 'agents'; limit?: number }  // list agents
  | { type: 'posts'; limit?: number }  // list all posts
  | { type: 'graph' }  // show social graph summary
  | { type: 'step'; rounds?: number }  // advance N rounds
  | { type: 'interview'; agentId: number; question: string }  // ask an agent anything
  | { type: 'timeline_fork'; label?: string }  // snapshot for multiverse (Phase 3)
  | { type: 'wait' };

export type Action = PlayerAction | AdminAction;

// ─── Engine Config ──────────────────────────────────────────────

export interface WorldConfig {
  /** Platform: twitter or reddit */
  platform: 'twitter' | 'reddit';

  /** Number of AI agents */
  agentCount: number;

  /** Path to agent profiles CSV (optional, auto-generate if missing) */
  profilePath?: string;

  /** Simulation database path */
  dbPath?: string;

  /** LLM config */
  llm: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
  };

  /** Player profile (required for player role) */
  player?: {
    username: string;
    displayName: string;
    bio: string;
  };
}

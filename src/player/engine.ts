/**
 * WorldEngine — core simulation engine for interactive mode.
 *
 * Wraps OASIS as a Python subprocess. Exposes a high-level API
 * for both Player and Admin roles. The engine doesn't know about
 * CLI or UI — it just runs the world.
 */

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type {
  WorldConfig, WorldState, Post, Comment, Notification,
  AgentProfile, PlayerAction, AdminAction, Action,
} from './types.js';

// ─── Engine ─────────────────────────────────────────────────────

export class WorldEngine {
  private config: WorldConfig;
  private process: ChildProcess | null = null;
  private round = 0;
  private running = false;
  private dbPath: string;
  private scriptPath: string;
  private playerId: number | null = null;
  private pendingNotifications: Notification[] = [];

  constructor(config: WorldConfig) {
    this.config = config;
    this.dbPath = config.dbPath ?? join(process.cwd(), 'data/social/world.db');
    this.scriptPath = join(
      dirname(new URL(import.meta.url).pathname),
      '..', '..', 'scripts', 'world-engine.py',
    );
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  /**
   * Initialize the world: generate profiles, create OASIS env, seed player.
   */
  async init(): Promise<void> {
    // Generate agent profiles if needed
    if (!this.config.profilePath) {
      this.config.profilePath = await this.generateProfiles();
    }

    // If player mode, append player to profiles
    if (this.config.player) {
      this.appendPlayerToProfiles();
    }

    // Start OASIS subprocess
    await this.startOasis();
    this.running = true;
  }

  /**
   * Execute a player action, then let agents react.
   */
  async playerAct(action: PlayerAction): Promise<WorldState> {
    if (!this.running) throw new Error('World not running. Call init() first.');

    if (action.type === 'feed' || action.type === 'notifications' || action.type === 'profile') {
      // Read-only actions — don't advance time, don't increment round
      return this.getWorldState();
    } else if (action.type === 'wait') {
      // Just advance one round
      await this.sendCommand({ type: 'step', rounds: 1 });
    } else {
      // Player action + agents react in one command
      await this.sendCommand({
        type: 'player_action_and_step',
        action,
        playerId: this.playerId,
      });
    }
    this.round++;

    // Collect notifications for player
    this.pendingNotifications = await this.readPlayerNotifications();

    return this.getWorldState();
  }

  /**
   * Execute an admin action.
   */
  async adminAct(action: AdminAction): Promise<WorldState> {
    if (!this.running) throw new Error('World not running. Call init() first.');

    switch (action.type) {
      case 'step': {
        const n = action.rounds ?? 1;
        for (let i = 0; i < n; i++) {
          await this.sendCommand({ type: 'step', rounds: 1 });
          this.round++;
        }
        break;
      }
      case 'inject_event':
        await this.sendCommand({
          type: 'inject_post',
          agentId: action.asAgent ?? 0,
          content: action.content,
        });
        break;
      case 'inject_news':
        await this.sendCommand({
          type: 'inject_post',
          agentId: 0, // system agent
          content: `📢 BREAKING: ${action.headline}`,
        });
        // Step to let agents react
        await this.sendCommand({ type: 'step', rounds: 1 });
        this.round++;
        break;
      case 'interview':
        // Interview is handled by reading agent's response
        await this.sendCommand({
          type: 'interview',
          agentId: action.agentId,
          question: action.question,
        });
        break;
      case 'kill_agent':
        await this.sendCommand({ type: 'kill_agent', agentId: action.agentId });
        break;
      case 'wait':
        await this.sendCommand({ type: 'step', rounds: 1 });
        this.round++;
        break;
      default:
        // status, agents, posts, graph — read-only, handled by getters
        break;
    }

    return this.getWorldState();
  }

  /**
   * Execute any action (dispatches by type).
   */
  async act(action: Action, role: 'player' | 'admin' = 'player'): Promise<WorldState> {
    if (role === 'admin' || this.isAdminAction(action)) {
      return this.adminAct(action as AdminAction);
    }
    return this.playerAct(action as PlayerAction);
  }

  /**
   * Shut down the simulation.
   */
  async shutdown(): Promise<void> {
    if (this.process) {
      await this.sendCommand({ type: 'shutdown' });
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this.running = false;
  }

  // ─── Queries (read from SQLite) ─────────────────────────────

  getWorldState(): WorldState {
    const db = this.openDb();
    try {
      const stats = this.queryStats(db);
      return {
        round: this.round,
        totalRounds: -1, // infinite in interactive mode
        totalAgents: stats.agents,
        totalPosts: stats.posts,
        totalComments: stats.comments,
        totalLikes: stats.likes,
        totalFollows: stats.follows,
        totalGroups: stats.groups,
        totalGroupMessages: stats.groupMessages,
        player: this.playerId != null ? {
          id: this.playerId,
          followers: this.queryCount(db, 'follow', 'followee_id', this.playerId),
          following: this.queryCount(db, 'follow', 'follower_id', this.playerId),
          posts: this.queryCount(db, 'post', 'user_id', this.playerId),
        } : undefined,
        notifications: this.pendingNotifications,
      };
    } finally {
      db.close?.();
    }
  }

  getFeed(limit = 20): Post[] {
    return this.queryPosts(limit);
  }

  getPost(postId: number): { post: Post; comments: Comment[] } | null {
    const post = this.queryPostById(postId);
    if (!post) return null;
    const comments = this.queryCommentsByPost(postId);
    return { post, comments };
  }

  getAgents(limit = 20): AgentProfile[] {
    return this.queryAgents(limit);
  }

  getAgent(agentId: number): AgentProfile | null {
    return this.queryAgentById(agentId);
  }

  // ─── Director Mode: AgentDirector integration ────────────────

  /**
   * Query an agent's feed from OASIS DB (via Python bridge).
   */
  async queryAgentFeed(agentId: number, limit = 10): Promise<Array<{
    post_id: number;
    user_id: number;
    author_name: string;
    content: string;
    num_likes: number;
    num_comments: number;
    num_reposts?: number;
    created_at?: string;
    commentList?: Array<{ comment_id: number; commenter_id: number; content: string; created_at?: string; author_name: string }>;
  }>> {
    const raw = await this.sendCommand({ type: 'query_feed', agentId, limit });
    try {
      const msg = JSON.parse(raw);
      return msg.feed ?? [];
    } catch { return []; }
  }

  /**
   * Query an agent's notifications from OASIS DB (via Python bridge).
   */
  async queryAgentNotifications(agentId: number, limit = 10): Promise<Array<{
    type: string;
    from_agent: string;
    content: string;
  }>> {
    const raw = await this.sendCommand({ type: 'query_notifications', agentId, limit });
    try {
      const msg = JSON.parse(raw);
      return msg.notifications ?? [];
    } catch { return []; }
  }

  /**
   * Query groups and agent's membership.
   */
  async queryGroups(agentId: number): Promise<{
    groups: Array<{ groupId: number; name: string }>;
    joined: number[];
  }> {
    const raw = await this.sendCommand({ type: 'query_groups', agentId });
    try {
      const msg = JSON.parse(raw);
      return { groups: msg.groups ?? [], joined: msg.joined ?? [] };
    } catch { return { groups: [], joined: [] }; }
  }

  /**
   * Query messages from a specific group.
   */
  async queryGroupMessages(groupId: number, limit = 20): Promise<Array<{
    message_id: number;
    sender_id: number;
    sender_name: string;
    content: string;
    sent_at: string;
  }>> {
    const raw = await this.sendCommand({ type: 'query_group_messages', groupId, limit });
    try {
      const msg = JSON.parse(raw);
      return msg.messages ?? [];
    } catch { return []; }
  }

  /**
   * Submit pre-decided actions for a directed step (AgentDirector mode).
   * Bypasses OASIS LLM — all decisions come from our director.
   */
  async directedStep(decisions: Array<{
    agentId: number;
    action: string;
    content?: string;
    targetPostId?: number;
    targetUserId?: number;
  }>): Promise<{ executed: number; skipped: number }> {
    const raw = await this.sendCommand({ type: 'directed_step', decisions });
    try {
      const msg = JSON.parse(raw);
      return { executed: msg.executed ?? 0, skipped: msg.skipped ?? 0 };
    } catch {
      return { executed: 0, skipped: 0 };
    }
  }

  // ─── Agent name management ─────────────────────────────────

  /** Update agent display name and user_name in DB */
  async updateAgentName(agentId: number, userName: string, displayName: string): Promise<void> {
    await this.sendCommand({
      type: 'update_agent_name',
      agentId,
      userName,
      displayName,
    });
  }

  // ─── State migration ───────────────────────────────────────

  /** Export social graph state to JSON for migration */
  async exportState(path?: string): Promise<{ path: string; tables: string[] }> {
    const exportPath = path ?? `${this.dbPath}.export.json`;
    const raw = await this.sendCommand({ type: 'export_state', path: exportPath });
    try {
      const msg = JSON.parse(raw);
      return { path: msg.path ?? exportPath, tables: msg.tables ?? [] };
    } catch {
      return { path: exportPath, tables: [] };
    }
  }

  /** Import social graph state from a previous export */
  async importState(path: string): Promise<Record<string, number>> {
    const raw = await this.sendCommand({ type: 'import_state', path });
    try {
      const msg = JSON.parse(raw);
      return msg.imported ?? {};
    } catch {
      return {};
    }
  }

  // ─── Internal: OASIS subprocess ─────────────────────────────

  private async startOasis(): Promise<void> {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      WORLDMIND_PLATFORM: this.config.platform,
      WORLDMIND_PROFILE_PATH: this.config.profilePath!,
      WORLDMIND_DB_PATH: this.dbPath,
      WORLDMIND_AGENT_COUNT: String(this.config.agentCount),
      OPENAI_API_KEY: this.config.llm.apiKey,
    };
    if (this.config.llm.baseUrl) env['OPENAI_API_BASE_URL'] = this.config.llm.baseUrl;
    if (this.config.llm.model) env['WORLDMIND_LLM_MODEL'] = this.config.llm.model;
    if (this.config.worldContext) env['WORLDMIND_WORLD_CONTEXT'] = this.config.worldContext;
    if (this.config.player) {
      env['WORLDMIND_PLAYER_USERNAME'] = this.config.player.username;
    }

    this.process = spawn('python3', [this.scriptPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Wait for ready signal (tolerant of non-JSON lines on stdout)
    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      const timeout = setTimeout(() => {
        reject(new Error('OASIS init timeout (300s). Check stderr for errors.'));
      }, 300_000);

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop()!; // keep incomplete line
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed);
            if (msg.type === 'ready') {
              this.playerId = msg.player_id ?? null;
              clearTimeout(timeout);
              this.process!.stdout!.removeListener('data', onData);
              resolve();
              return;
            }
          } catch {
            // Non-JSON line from OASIS internals — ignore
          }
        }
      };
      this.process!.stdout!.on('data', onData);
      this.process!.stderr!.on('data', (chunk: Buffer) => {
        const msg = chunk.toString().trim();
        if (msg) process.stderr.write(`[OASIS] ${msg}\n`);
      });
      this.process!.on('exit', (code) => {
        clearTimeout(timeout);
        if (!this.running) return;
        reject(new Error(`OASIS exited with code ${code}`));
      });
    });
  }

  private sendCommand(cmd: Record<string, unknown>): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error('OASIS process not writable'));
        return;
      }

      let buffer = '';
      const timeout = setTimeout(() => {
        this.process!.stdout!.removeListener('data', onData);
        resolve('{"type":"timeout"}');
      }, 300_000);

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop()!;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed);
            // Only resolve on our protocol messages (not OASIS internal JSON)
            if (msg.type) {
              clearTimeout(timeout);
              this.process!.stdout!.removeListener('data', onData);
              resolve(trimmed);
              return;
            }
          } catch {
            // Non-JSON line — skip
          }
        }
      };

      this.process!.stdout!.on('data', onData);
      this.process!.stdin!.write(JSON.stringify(cmd) + '\n');
    });
  }

  // ─── Internal: Profile generation ───────────────────────────

  private async generateProfiles(): Promise<string> {
    const dir = join(process.cwd(), 'data/social');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `agents_${this.config.agentCount}.csv`);

    if (existsSync(path)) return path;

    // Generate diverse agent profiles
    const profiles = this.createDefaultProfiles(this.config.agentCount);
    const csv = ['username,description,user_char', ...profiles].join('\n');
    writeFileSync(path, csv, 'utf-8');
    return path;
  }

  private createDefaultProfiles(count: number): string[] {
    // Archetypes for diverse social simulation
    const archetypes = [
      { role: 'engineer', desc: 'Software engineer', char: 'Pragmatic, technical, values working code. Shares project updates and technical insights.' },
      { role: 'vc', desc: 'Tech investor', char: 'Tracks emerging trends. Evaluates market potential. Amplifies projects with traction.' },
      { role: 'researcher', desc: 'ML researcher', char: 'Academic rigor. Publishes papers. Skeptical of unvalidated claims. Values reproducibility.' },
      { role: 'indie', desc: 'Indie hacker', char: 'Builds and ships fast. Interested in monetization and developer tools. Practical.' },
      { role: 'journalist', desc: 'Tech journalist', char: 'Covers AI and tech. Asks hard questions. Amplifies stories. Chases engagement.' },
      { role: 'skeptic', desc: 'Tech critic', char: 'Contrarian. Challenges hype. Points out failures and risks. Popular for hot takes.' },
      { role: 'pm', desc: 'Product manager', char: 'Follows developer tools and platforms. Interested in adoption and developer experience.' },
      { role: 'student', desc: 'CS student', char: 'Curious. Learning about AI and systems. Asks questions. Shares learning notes.' },
      { role: 'designer', desc: 'UX designer', char: 'Focused on user experience. Shares design critiques and usability insights.' },
      { role: 'founder', desc: 'Startup founder', char: 'Building a company. Interested in growth, hiring, and market trends. Hustles.' },
      { role: 'influencer', desc: 'Tech content creator', char: 'Creates viral content. Simplifies complex topics. High follower count. Engagement-driven.' },
      { role: 'maintainer', desc: 'Open source maintainer', char: 'Opinionated about code quality. Cares about licensing and governance. Burns out.' },
    ];

    const profiles: string[] = [];
    for (let i = 0; i < count; i++) {
      const arch = archetypes[i % archetypes.length]!;
      const suffix = i >= archetypes.length ? `_${Math.floor(i / archetypes.length) + 1}` : '';
      const username = `${arch.role}${suffix}`;
      // CSV-escape: wrap in quotes, double any internal quotes
      const desc = `"${arch.desc.replace(/"/g, '""')}"`;
      const char = `"${arch.char.replace(/"/g, '""')}"`;
      profiles.push(`${username},${desc},${char}`);
    }
    return profiles;
  }

  private appendPlayerToProfiles(): void {
    if (!this.config.profilePath || !this.config.player) return;
    const content = readFileSync(this.config.profilePath, 'utf-8');
    // CSV columns: username,description,user_char
    const desc = this.config.player.displayName.replace(/"/g, '""');
    const char = this.config.player.bio.replace(/"/g, '""');
    const playerLine = `${this.config.player.username},"${desc}","${char}"`;
    // Don't modify original file — write to a temp copy
    const tmpPath = this.config.profilePath.replace('.csv', '_with_player.csv');
    writeFileSync(tmpPath, content.trimEnd() + '\n' + playerLine + '\n', 'utf-8');
    this.config.profilePath = tmpPath;
  }

  // ─── Internal: SQLite queries ───────────────────────────────

  private openDb() {
    // Use execSync to query SQLite (no native binding needed)
    return {
      query: (sql: string): string => {
        try {
          return execSync(
            `sqlite3 -json "${this.dbPath}" "${sql.replace(/"/g, '\\"')}"`,
            { encoding: 'utf-8', timeout: 5000 },
          );
        } catch { return '[]'; }
      },
      close: () => {},
    };
  }

  private queryStats(db: ReturnType<typeof this.openDb>) {
    const parse = (sql: string) => {
      try {
        const r = JSON.parse(db.query(sql));
        return r[0]?.['COUNT(*)'] ?? 0;
      } catch { return 0; }
    };
    return {
      agents: parse('SELECT COUNT(*) FROM user'),
      posts: parse('SELECT COUNT(*) FROM post'),
      comments: parse('SELECT COUNT(*) FROM comment'),
      likes: parse('SELECT COUNT(*) FROM like'),
      follows: parse('SELECT COUNT(*) FROM follow'),
      groups: parse('SELECT COUNT(*) FROM chat_group'),
      groupMessages: parse('SELECT COUNT(*) FROM group_messages'),
    };
  }

  private queryCount(db: ReturnType<typeof this.openDb>, table: string, col: string, val: number): number {
    try {
      const r = JSON.parse(db.query(`SELECT COUNT(*) FROM ${table} WHERE ${col} = ${val}`));
      return r[0]?.['COUNT(*)'] ?? 0;
    } catch { return 0; }
  }

  private queryPosts(limit: number): Post[] {
    try {
      const db = this.openDb();
      const rows = JSON.parse(db.query(
        `SELECT p.post_id, p.user_id, COALESCE(NULLIF(u.user_name, ''), u.name, 'agent_' || u.user_id) as display_name, 
                p.content, p.quote_content, p.original_post_id,
                p.num_likes, p.num_shares, p.created_at,
                (SELECT COUNT(*) FROM comment c WHERE c.post_id = p.post_id) as num_comments,
                COALESCE(NULLIF(ou.user_name, ''), ou.name) as original_author
         FROM post p 
         LEFT JOIN user u ON p.user_id = u.user_id 
         LEFT JOIN post op ON p.original_post_id = op.post_id
         LEFT JOIN user ou ON op.user_id = ou.user_id
         ORDER BY p.post_id DESC LIMIT ${limit}`
      ));
      return rows.map((r: any) => {
        // Format content based on post type
        let content: string;
        if (r.quote_content) {
          // Quote post: original + commentary
          const origAuthor = r.original_author ? `@${r.original_author}` : '原帖';
          content = `🔄 转发 ${origAuthor}: ${r.content}\n\n💬 ${r.quote_content}`;
        } else if (r.original_post_id) {
          // Pure repost: just the original content with attribution
          const origAuthor = r.original_author ? `@${r.original_author}` : '原帖';
          content = `🔄 转发 ${origAuthor}: ${r.content}`;
        } else {
          content = r.content ?? '';
        }
        return {
          id: r.post_id,
          authorId: r.user_id,
          authorName: r.display_name ?? r.user_name ?? `agent_${r.user_id}`,
          content,
          likes: r.num_likes ?? 0,
          comments: r.num_comments ?? 0,
          reposts: r.num_shares ?? 0,
          createdAt: r.created_at ?? '',
          isPlayer: r.user_id === this.playerId,
        };
      });
    } catch { return []; }
  }

  private queryPostById(postId: number): Post | null {
    try {
      const db = this.openDb();
      const rows = JSON.parse(db.query(
        `SELECT p.post_id, p.user_id, COALESCE(NULLIF(u.user_name, ''), u.name, 'agent_' || u.user_id) as display_name, 
                p.content, p.quote_content, p.original_post_id, p.num_likes, p.num_shares, p.created_at,
                COALESCE(NULLIF(ou.user_name, ''), ou.name) as original_author
         FROM post p 
         LEFT JOIN user u ON p.user_id = u.user_id 
         LEFT JOIN post op ON p.original_post_id = op.post_id
         LEFT JOIN user ou ON op.user_id = ou.user_id
         WHERE p.post_id = ${postId}`
      ));
      if (!rows[0]) return null;
      const r = rows[0];
      const comments = this.queryCommentsByPost(r.post_id);
      let content: string;
      if (r.quote_content) {
        const origAuthor = r.original_author ? `@${r.original_author}` : '原帖';
        content = `🔄 转发 ${origAuthor}: ${r.content}\n\n💬 ${r.quote_content}`;
      } else if (r.original_post_id) {
        const origAuthor = r.original_author ? `@${r.original_author}` : '原帖';
        content = `🔄 转发 ${origAuthor}: ${r.content}`;
      } else {
        content = r.content ?? '';
      }
      return {
        id: r.post_id, authorId: r.user_id, authorName: r.display_name ?? r.user_name ?? `agent_${r.user_id}`,
        content, likes: r.num_likes ?? 0, comments: comments.length,
        reposts: r.num_shares ?? 0, createdAt: r.created_at ?? '', isPlayer: r.user_id === this.playerId,
      };
    } catch { return null; }
  }

  private queryCommentsByPost(postId: number): Comment[] {
    try {
      const db = this.openDb();
      const rows = JSON.parse(db.query(
        `SELECT c.comment_id, c.post_id, c.user_id, COALESCE(NULLIF(u.user_name, ''), u.name, 'agent_' || u.user_id) as display_name, c.content, c.created_at FROM comment c LEFT JOIN user u ON c.user_id = u.user_id WHERE c.post_id = ${postId} ORDER BY c.comment_id`
      ));
      return rows.map((r: any) => ({
        id: r.comment_id, postId: r.post_id, authorId: r.user_id,
        authorName: r.display_name ?? r.user_name ?? `agent_${r.user_id}`,
        content: r.content ?? '', createdAt: r.created_at ?? '',
        isPlayer: r.user_id === this.playerId,
      }));
    } catch { return []; }
  }

  private queryAgents(limit: number): AgentProfile[] {
    try {
      const db = this.openDb();
      const rows = JSON.parse(db.query(
        `SELECT user_id, user_name, name, bio, num_followers, num_followings FROM user LIMIT ${limit}`
      ));
      return rows.map((r: any) => ({
        id: r.user_id, username: r.user_name ?? '', displayName: r.name ?? '',
        bio: r.bio ?? '', followers: r.num_followers ?? 0,
        following: r.num_followings ?? 0, isPlayer: r.user_id === this.playerId,
      }));
    } catch { return []; }
  }

  private queryAgentById(agentId: number): AgentProfile | null {
    try {
      const db = this.openDb();
      const rows = JSON.parse(db.query(
        `SELECT user_id, user_name, name, bio, num_followers, num_followings FROM user WHERE user_id = ${agentId}`
      ));
      if (!rows[0]) return null;
      const r = rows[0];
      return {
        id: r.user_id, username: r.user_name ?? '', displayName: r.name ?? '',
        bio: r.bio ?? '', followers: r.num_followers ?? 0,
        following: r.num_followings ?? 0, isPlayer: r.user_id === this.playerId,
      };
    } catch { return null; }
  }

  private async readPlayerNotifications(): Promise<Notification[]> {
    if (this.playerId == null) return [];
    // Read recent actions targeting the player
    try {
      const db = this.openDb();
      const likes = JSON.parse(db.query(
        `SELECT l.user_id, u.user_name, l.post_id FROM like l LEFT JOIN user u ON l.user_id = u.user_id LEFT JOIN post p ON l.post_id = p.post_id WHERE p.user_id = ${this.playerId} ORDER BY l.like_id DESC LIMIT 10`
      ));
      const follows = JSON.parse(db.query(
        `SELECT f.follower_id, u.user_name FROM follow f LEFT JOIN user u ON f.follower_id = u.user_id WHERE f.followee_id = ${this.playerId} ORDER BY f.follow_id DESC LIMIT 10`
      ));
      const comments = JSON.parse(db.query(
        `SELECT c.user_id, u.user_name, c.content FROM comment c LEFT JOIN user u ON c.user_id = u.user_id LEFT JOIN post p ON c.post_id = p.post_id WHERE p.user_id = ${this.playerId} ORDER BY c.comment_id DESC LIMIT 10`
      ));

      const notifs: Notification[] = [];
      for (const l of likes) {
        notifs.push({ type: 'like', fromAgent: l.user_name ?? `agent_${l.user_id}`, content: `liked your post`, timestamp: '' });
      }
      for (const f of follows) {
        notifs.push({ type: 'follow', fromAgent: f.user_name ?? `agent_${f.follower_id}`, content: 'followed you', timestamp: '' });
      }
      for (const c of comments) {
        notifs.push({ type: 'comment', fromAgent: c.user_name ?? `agent_${c.user_id}`, content: c.content?.slice(0, 80) ?? '', timestamp: '' });
      }
      return notifs;
    } catch { return []; }
  }

  /** Query all groups with their messages */
  getGroups(): Array<{ id: number; name: string; messages: Array<{ sender: string; content: string }> }> {
    try {
      const db = this.openDb();
      const groups = JSON.parse(db.query(
        `SELECT group_id, name FROM chat_group ORDER BY group_id`
      ));
      return groups.map((g: any) => {
        const msgs = JSON.parse(db.query(
          `SELECT gm.content, COALESCE(NULLIF(u.user_name, ''), u.name, 'agent_' || gm.sender_id) as sender
           FROM group_messages gm
           LEFT JOIN user u ON gm.sender_id = u.user_id
           WHERE gm.group_id = ${g.group_id}
           ORDER BY gm.message_id`
        ));
        return {
          id: g.group_id,
          name: g.name,
          messages: msgs.map((m: any) => ({ sender: m.sender, content: m.content })),
        };
      });
    } catch { return []; }
  }

  /** Query follow graph: who follows whom */
  getFollowGraph(): Array<{ follower: string; followee: string }> {
    try {
      const db = this.openDb();
      const rows = JSON.parse(db.query(
        `SELECT COALESCE(NULLIF(u1.user_name, ''), u1.name) as follower,
                COALESCE(NULLIF(u2.user_name, ''), u2.name) as followee
         FROM follow f
         JOIN user u1 ON f.follower_id = u1.user_id
         JOIN user u2 ON f.followee_id = u2.user_id
         ORDER BY follower, followee`
      ));
      return rows.map((r: any) => ({ follower: r.follower, followee: r.followee }));
    } catch { return []; }
  }

  /** Query recent trace entries (agent actions log) */
  getTrace(limit = 50): Array<{ agent: string; action: string; info: string; time: string }> {
    try {
      const db = this.openDb();
      const rows = JSON.parse(db.query(
        `SELECT COALESCE(NULLIF(u.user_name, ''), u.name) as agent, t.action, t.info, t.created_at
         FROM trace t
         JOIN user u ON t.user_id = u.user_id
         WHERE t.action NOT IN ('sign_up', 'refresh')
         ORDER BY t.created_at DESC
         LIMIT ${limit}`
      ));
      return rows.map((r: any) => ({
        agent: r.agent,
        action: r.action,
        info: (r.info ?? '').slice(0, 60),
        time: r.created_at ?? '',
      }));
    } catch { return []; }
  }

  private isAdminAction(action: Action): boolean {
    return [
      'inject_event', 'inject_news', 'kill_agent', 'spawn_agent',
      'mutate_agent', 'status', 'agents', 'posts', 'graph',
      'step', 'interview', 'timeline_fork',
    ].includes(action.type);
  }
}

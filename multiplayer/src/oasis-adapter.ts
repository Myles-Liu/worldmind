/**
 * OASIS Platform Adapter
 *
 * Bridges the multiplayer PlatformAdapter interface to WorldMind's
 * existing WorldEngine (which wraps the OASIS Python subprocess).
 *
 * This is the only file in multiplayer/ that imports from ../../src.
 * To deploy multiplayer without OASIS, replace this with another adapter.
 */

import type { PlatformAdapter, FeedItem, Notification, Decision, WorldState, Persona } from './types.js';
import { WorldEngine } from '../../src/player/engine.js';

export class OasisPlatformAdapter implements PlatformAdapter {
  private engine: WorldEngine;
  private playerSlotIds: number[];
  private nextSlotIndex = 0;
  private recycledSlots: number[] = [];

  constructor(engine: WorldEngine, playerSlotIds: number[] = []) {
    this.engine = engine;
    this.playerSlotIds = playerSlotIds;
  }

  async queryFeed(agentId: number, limit: number): Promise<FeedItem[]> {
    const raw = await this.engine.queryAgentFeed(agentId, limit);
    return raw.map(r => ({
      postId: r.post_id,
      authorId: r.user_id,
      authorName: r.author_name,
      content: r.content,
      likes: r.num_likes,
      comments: r.num_comments,
      reposts: r.num_reposts ?? 0,
      createdAt: r.created_at,
      commentList: (r.commentList ?? []).map((c: any) => ({
        commentId: c.comment_id,
        authorId: c.commenter_id,
        authorName: c.author_name,
        content: c.content,
        createdAt: c.created_at,
      })),
    }));
  }

  async queryNotifications(agentId: number, limit: number): Promise<Notification[]> {
    const raw = await this.engine.queryAgentNotifications(agentId, limit);
    return raw.map(r => ({
      type: r.type,
      fromAgent: r.from_agent,
      content: r.content,
    }));
  }

  async queryGroups(agentId: number): Promise<{ groups: Array<{ groupId: number; name: string }>; joined: number[] }> {
    return this.engine.queryGroups(agentId);
  }

  async queryGroupMessages(groupId: number, limit = 20): Promise<Array<{ message_id: number; sender_name: string; content: string }>> {
    return this.engine.queryGroupMessages(groupId, limit);
  }

  async executeBatch(decisions: Decision[]): Promise<{ executed: number; skipped: number }> {
    return this.engine.directedStep(decisions);
  }

  getState(): WorldState {
    const s = this.engine.getWorldState();
    return {
      round: 0, // server manages round count
      totalAgents: s.totalAgents,
      totalPlayers: 0, // server manages player count
      totalPosts: s.totalPosts,
      totalComments: s.totalComments,
      totalLikes: s.totalLikes,
      totalFollows: s.totalFollows,
    };
  }

  getAgents(): Persona[] {
    return this.engine.getAgents(100).map(a => ({
      id: a.id,
      username: a.username,
      role: 'npc',
      personality: a.bio,
    }));
  }

  async registerPlayer(name: string, _persona?: { role: string; personality: string }): Promise<number> {
    // First try recycled slots, then pre-allocated
    let id: number;
    if (this.recycledSlots.length > 0) {
      id = this.recycledSlots.pop()!;
    } else if (this.nextSlotIndex >= this.playerSlotIds.length) {
      throw new Error(`No player slots available (max ${this.playerSlotIds.length}). Restart with more --player-slots or use --resume to expand.`);
    } else {
      id = this.playerSlotIds[this.nextSlotIndex]!;
      this.nextSlotIndex++;
    }

    // Update DB so the player's display name is correct instead of "Player N"
    await this.engine.updateAgentName(id, name, name);

    return id;
  }

  /** Release a player slot back for reuse */
  releasePlayer(playerId: number): void {
    if (this.playerSlotIds.includes(playerId)) {
      this.recycledSlots.push(playerId);
    }
  }

  /** Export social graph state for migration */
  async exportState(path?: string): Promise<{ path: string; tables: string[] }> {
    return this.engine.exportState(path);
  }

  /** Import social graph state from a previous export */
  async importState(path: string): Promise<Record<string, number>> {
    return this.engine.importState(path);
  }

  /** Number of available slots (pre-allocated + recycled) */
  get availableSlots(): number {
    return (this.playerSlotIds.length - this.nextSlotIndex) + this.recycledSlots.length;
  }

  async shutdown(): Promise<void> {
    await this.engine.shutdown();
  }
}

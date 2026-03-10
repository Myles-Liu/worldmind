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
    // Use pre-allocated player slot IDs that are registered in OASIS DB
    if (this.nextSlotIndex >= this.playerSlotIds.length) {
      throw new Error(`No player slots available (max ${this.playerSlotIds.length})`);
    }
    const id = this.playerSlotIds[this.nextSlotIndex]!;
    this.nextSlotIndex++;
    return id;
  }

  async shutdown(): Promise<void> {
    await this.engine.shutdown();
  }
}

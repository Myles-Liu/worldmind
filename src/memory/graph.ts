import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RelationshipType } from '../types/entity.js';

// ─── Graph Types ────────────────────────────────────────────────

export interface GraphNode {
  entityId: string;
  type: string;
  label: string;
  metrics: {
    degree: number;        // Number of connections
    pageRank?: number;
    betweenness?: number;
    communityId?: string;
  };
}

export interface GraphEdge {
  from: string;
  to: string;
  type: RelationshipType;
  weight: number;
  validFrom: string;
  validTo: string | null;
  metadata: Record<string, unknown>;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: Community[];
  lastUpdated: string;
  version: number;
}

export interface Community {
  id: string;
  name: string;
  members: string[];       // Entity IDs
  cohesion: number;        // 0-1, how tightly connected
  formedAt: string;
  topics: string[];
}

// ─── Temporal Graph ─────────────────────────────────────────────

export class TemporalGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: GraphEdge[] = [];
  private communities: Map<string, Community> = new Map();
  private dataDir: string;
  private version: number = 0;

  constructor(dataDir: string = 'data/graph') {
    this.dataDir = dataDir;
  }

  /**
   * Load graph from disk.
   */
  async load(): Promise<void> {
    // TODO: Implement loading from data/graph/graph.json
  }

  /**
   * Persist graph to disk.
   */
  async save(): Promise<void> {
    const snapshot: GraphSnapshot = {
      nodes: Array.from(this.nodes.values()),
      edges: this.edges,
      communities: Array.from(this.communities.values()),
      lastUpdated: new Date().toISOString(),
      version: this.version,
    };

    await fs.mkdir(this.dataDir, { recursive: true });
    const filePath = path.join(this.dataDir, 'graph.json');
    await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2));
  }

  /**
   * Add or update a node.
   */
  upsertNode(entityId: string, type: string, label: string): GraphNode {
    const existing = this.nodes.get(entityId);
    if (existing) {
      existing.label = label;
      return existing;
    }

    const node: GraphNode = {
      entityId,
      type,
      label,
      metrics: { degree: 0 },
    };
    this.nodes.set(entityId, node);
    this.version++;
    return node;
  }

  /**
   * Add an edge (relationship) with temporal data.
   */
  addEdge(edge: GraphEdge): void {
    // Close any existing edge of the same type between the same nodes
    for (const existing of this.edges) {
      if (
        existing.from === edge.from &&
        existing.to === edge.to &&
        existing.type === edge.type &&
        !existing.validTo
      ) {
        existing.validTo = edge.validFrom;
      }
    }

    this.edges.push(edge);
    this.updateDegrees();
    this.version++;
  }

  /**
   * Query edges active at a specific point in time.
   */
  queryEdgesAt(timestamp: string): GraphEdge[] {
    return this.edges.filter(
      (e) => e.validFrom <= timestamp && (!e.validTo || e.validTo > timestamp),
    );
  }

  /**
   * Get all current (active) edges for an entity.
   */
  getEntityEdges(entityId: string): GraphEdge[] {
    return this.edges.filter(
      (e) =>
        (e.from === entityId || e.to === entityId) && !e.validTo,
    );
  }

  /**
   * Get a node by entity ID.
   */
  getNode(entityId: string): GraphNode | null {
    return this.nodes.get(entityId) ?? null;
  }

  /**
   * Get all nodes.
   */
  getAllNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Find shortest path between two entities (BFS).
   */
  findPath(fromId: string, toId: string): string[] | null {
    // TODO: Implement BFS path finding on current edges
    return null;
  }

  /**
   * Detect communities using simple modularity-based clustering.
   */
  detectCommunities(): Community[] {
    // TODO: Implement community detection
    // - Use label propagation or similar lightweight algorithm
    // - Update this.communities
    return [];
  }

  // ─── Private ────────────────────────────────────────────────────

  private updateDegrees(): void {
    // Reset degrees
    for (const node of this.nodes.values()) {
      node.metrics.degree = 0;
    }
    // Count active edges
    for (const edge of this.edges) {
      if (edge.validTo) continue;
      const fromNode = this.nodes.get(edge.from);
      const toNode = this.nodes.get(edge.to);
      if (fromNode) fromNode.metrics.degree++;
      if (toNode) toNode.metrics.degree++;
    }
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    return this.edges.filter((e) => !e.validTo).length;
  }
}

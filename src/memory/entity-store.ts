import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  EntityProfile,
  type EntityType,
  type AgentAnnotation,
  type TimelineEvent,
  type Relationship,
  createEmptyProfile,
} from '../types/entity.js';

// ─── Entity Store ───────────────────────────────────────────────

export class EntityStore {
  private entities: Map<string, EntityProfile> = new Map();
  private dataDir: string;
  private dirty: Set<string> = new Set(); // Track which entities need persisting

  constructor(dataDir: string = 'data/entities') {
    this.dataDir = dataDir;
  }

  /**
   * Load all entities from disk into memory.
   */
  async load(): Promise<void> {
    try {
      const typeDir = await fs.readdir(this.dataDir).catch(() => []);
      for (const type of typeDir) {
        const typePath = path.join(this.dataDir, type);
        const stat = await fs.stat(typePath).catch(() => null);
        if (!stat?.isDirectory()) continue;

        const files = await fs.readdir(typePath).catch(() => []);
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          try {
            const content = await fs.readFile(path.join(typePath, file), 'utf-8');
            const entity = JSON.parse(content) as EntityProfile;
            this.entities.set(entity.id, entity);
          } catch {
            // Skip invalid files
          }
        }
      }
    } catch {
      // Data directory doesn't exist yet — that's fine
    }
  }

  /**
   * Persist all dirty entities to disk.
   */
  async save(): Promise<void> {
    for (const id of this.dirty) {
      const entity = this.entities.get(id);
      if (!entity) continue;

      const filePath = this.getEntityPath(entity.id, entity.type);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(entity, null, 2));
    }
    this.dirty.clear();
  }

  /**
   * Get an entity by ID.
   */
  get(id: string): EntityProfile | null {
    return this.entities.get(id) ?? null;
  }

  /**
   * Get or create an entity profile.
   */
  getOrCreate(
    id: string,
    type: EntityType,
    name: string,
    metadata: Record<string, unknown> = {},
  ): EntityProfile {
    const existing = this.entities.get(id);
    if (existing) return existing;

    const profile = createEmptyProfile(id, type, name, metadata);
    this.entities.set(id, profile);
    this.dirty.add(id);
    return profile;
  }

  /**
   * Update entity metadata.
   */
  updateMetadata(id: string, metadata: Record<string, unknown>): void {
    const entity = this.entities.get(id);
    if (!entity) return;

    entity.metadata = { ...entity.metadata, ...metadata };
    entity.lastUpdated = new Date().toISOString();
    entity.version++;
    this.dirty.add(id);
  }

  /**
   * Add a timeline event to an entity.
   */
  addTimelineEvent(id: string, event: TimelineEvent): void {
    const entity = this.entities.get(id);
    if (!entity) return;

    entity.timeline.push(event);
    entity.lastUpdated = new Date().toISOString();
    entity.version++;
    this.dirty.add(id);
  }

  /**
   * Add or update a relationship.
   */
  addRelationship(id: string, relationship: Relationship): void {
    const entity = this.entities.get(id);
    if (!entity) return;

    // Check if relationship already exists — update if so
    const existing = entity.relationships.findIndex(
      (r) => r.targetEntityId === relationship.targetEntityId && r.type === relationship.type,
    );
    if (existing >= 0) {
      entity.relationships[existing] = relationship;
    } else {
      entity.relationships.push(relationship);
    }

    entity.lastUpdated = new Date().toISOString();
    entity.version++;
    this.dirty.add(id);
  }

  /**
   * Add an agent annotation.
   */
  addAnnotation(id: string, annotation: AgentAnnotation): void {
    const entity = this.entities.get(id);
    if (!entity) return;

    entity.agentAnnotations.push(annotation);
    entity.lastUpdated = new Date().toISOString();
    entity.version++;
    this.dirty.add(id);
  }

  /**
   * Search entities by name or metadata.
   */
  search(query: string, type?: EntityType): EntityProfile[] {
    const lowerQuery = query.toLowerCase();
    const results: EntityProfile[] = [];

    for (const entity of this.entities.values()) {
      if (type && entity.type !== type) continue;
      if (
        entity.name.toLowerCase().includes(lowerQuery) ||
        entity.id.toLowerCase().includes(lowerQuery)
      ) {
        results.push(entity);
      }
    }

    return results;
  }

  /**
   * Get all entities of a given type.
   */
  listByType(type: EntityType): EntityProfile[] {
    return Array.from(this.entities.values()).filter((e) => e.type === type);
  }

  /**
   * Get entity count.
   */
  get size(): number {
    return this.entities.size;
  }

  // ─── Private ────────────────────────────────────────────────────

  private getEntityPath(id: string, type: EntityType): string {
    // id format: "repo:facebook/react" → file: data/entities/repo/facebook__react.json
    const safeId = id.replace(`${type}:`, '').replace(/\//g, '__');
    return path.join(this.dataDir, type, `${safeId}.json`);
  }
}

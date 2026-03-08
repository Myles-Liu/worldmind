import { z } from 'zod';

// ─── Entity Types ───────────────────────────────────────────────

export const EntityType = z.enum(['repo', 'user', 'organization']);
export type EntityType = z.infer<typeof EntityType>;

// ─── Repo Metadata ──────────────────────────────────────────────

export const RepoMetadata = z.object({
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  description: z.string().nullable(),
  language: z.string().nullable(),
  topics: z.array(z.string()),
  stars: z.number(),
  forks: z.number(),
  openIssues: z.number(),
  watchers: z.number(),
  license: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  homepage: z.string().nullable(),
  isArchived: z.boolean(),
  isFork: z.boolean(),
  defaultBranch: z.string(),
});
export type RepoMetadata = z.infer<typeof RepoMetadata>;

// ─── User Metadata ──────────────────────────────────────────────

export const UserMetadata = z.object({
  login: z.string(),
  name: z.string().nullable(),
  bio: z.string().nullable(),
  company: z.string().nullable(),
  location: z.string().nullable(),
  followers: z.number(),
  following: z.number(),
  publicRepos: z.number(),
  createdAt: z.string(),
});
export type UserMetadata = z.infer<typeof UserMetadata>;

// ─── Organization Metadata ──────────────────────────────────────

export const OrgMetadata = z.object({
  login: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  publicRepos: z.number(),
  publicMembers: z.number(),
  createdAt: z.string(),
});
export type OrgMetadata = z.infer<typeof OrgMetadata>;

// ─── Timeline Event ─────────────────────────────────────────────

export const TimelineEvent = z.object({
  timestamp: z.string(),
  type: z.string(),
  summary: z.string(),
  data: z.record(z.unknown()).optional(),
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;

// ─── Relationship ───────────────────────────────────────────────

export const RelationshipType = z.enum([
  'contributes_to',
  'stars',
  'forks',
  'follows',
  'member_of',
  'depends_on',
  'competes_with',
  'related_to',
]);
export type RelationshipType = z.infer<typeof RelationshipType>;

export const Relationship = z.object({
  targetEntityId: z.string(),
  type: RelationshipType,
  weight: z.number().min(0).max(1),
  metadata: z.record(z.unknown()).optional(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
});
export type Relationship = z.infer<typeof Relationship>;

// ─── Agent Annotation ───────────────────────────────────────────

export const AgentAnnotation = z.object({
  agentName: z.string(),
  type: z.string(), // e.g., 'assessment', 'impression', 'flag'
  content: z.string(),
  confidence: z.number().min(0).max(1),
  timestamp: z.string(),
});
export type AgentAnnotation = z.infer<typeof AgentAnnotation>;

// ─── Entity Profile ─────────────────────────────────────────────

export const EntityProfile = z.object({
  id: z.string(), // e.g., "repo:facebook/react", "user:torvalds"
  type: EntityType,
  name: z.string(),
  metadata: z.record(z.unknown()),
  timeline: z.array(TimelineEvent),
  relationships: z.array(Relationship),
  agentAnnotations: z.array(AgentAnnotation),
  firstSeen: z.string(),
  lastUpdated: z.string(),
  version: z.number().int().min(0),
});
export type EntityProfile = z.infer<typeof EntityProfile>;

// ─── Helpers ────────────────────────────────────────────────────

export function makeEntityId(type: EntityType, identifier: string): string {
  return `${type}:${identifier}`;
}

export function createEmptyProfile(
  id: string,
  type: EntityType,
  name: string,
  metadata: Record<string, unknown> = {},
): EntityProfile {
  const now = new Date().toISOString();
  return {
    id,
    type,
    name,
    metadata,
    timeline: [],
    relationships: [],
    agentAnnotations: [],
    firstSeen: now,
    lastUpdated: now,
    version: 0,
  };
}

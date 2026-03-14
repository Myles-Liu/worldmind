/**
 * Classic Text Domain Types
 * 
 * Types for ancient Chinese text interpretation and dramatization.
 */

import { z } from 'zod';

// ─── Scene Types ────────────────────────────────────────────────

export const SceneTypeSchema = z.enum([
  'warfare',      // 战争场景
  'business',     // 商业场景
  'interpersonal',// 人际场景
  'workplace',    // 职场场景
  'custom',       // 自定义场景
]);
export type SceneType = z.infer<typeof SceneTypeSchema>;

// ─── Role Types ─────────────────────────────────────────────────

export const RoleTypeSchema = z.enum([
  'protagonist',  // 主角（运用原则的一方）
  'antagonist',   // 对手（被影响的一方）
  'advisor',      // 谋士/顾问
  'narrator',     // 旁白（解读原理）
  'observer',     // 旁观者
]);
export type RoleType = z.infer<typeof RoleTypeSchema>;

// ─── Character Definition ───────────────────────────────────────

export interface Character {
  id: string;
  name: string;
  role: RoleType;
  personality: string;
  goals: string[];
  background: string;
}

// ─── Script Structure ───────────────────────────────────────────

export interface ScriptAct {
  actNumber: number;
  title: string;           // e.g., "知己知彼"
  description: string;
  dialogues: Dialogue[];
  principleApplied: string; // Which principle is being demonstrated
}

export interface Dialogue {
  speaker: string;         // Character id or 'narrator'
  content: string;
  isThought?: boolean;     // Internal monologue
  emotion?: string;        // happy, worried, confident, etc.
}

export interface Script {
  id: string;
  sourceText: string;      // Original ancient text
  sourceBook: string;      // e.g., "孙子兵法"
  sourceChapter: string;   // e.g., "谋攻篇"
  principle: string;       // The principle being illustrated
  interpretation: string;  // Modern interpretation
  sceneType: SceneType;
  sceneDescription: string;
  characters: Character[];
  acts: ScriptAct[];
  epilogue: string;        // Narrator's final commentary
  createdAt: string;
}

// ─── Input for Script Generation ────────────────────────────────

export interface ScriptRequest {
  sourceText: string;      // Original text passage
  sourceBook: string;
  sourceChapter?: string;
  sceneType: SceneType;
  customSceneDescription?: string;  // For custom scenes
  characterNames?: Record<RoleType, string>; // Override default names
}

// ─── OASIS Integration ──────────────────────────────────────────

export interface OasisAgentConfig {
  characterId: string;
  personality: string;
  goals: string[];
  systemPrompt: string;
}

export interface DramatizationConfig {
  script: Script;
  agentConfigs: OasisAgentConfig[];
  maxTurns: number;
  allowImprov: boolean;   // Can agents deviate from script?
}

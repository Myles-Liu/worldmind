/**
 * Classic Text Domain
 * 
 * Dramatizes ancient wisdom through modern scenarios using multi-agent simulation.
 * 
 * Usage:
 * ```ts
 * import { createClassicTextAdapter } from 'worldmind/domains/classic-text';
 * 
 * const adapter = createClassicTextAdapter();
 * 
 * const result = await adapter.dramatizeText({
 *   sourceText: '知己知彼，百战不殆；不知彼而知己，一胜一负；...',
 *   sourceBook: '孙子兵法',
 *   sourceChapter: '谋攻篇',
 *   sceneType: 'business',
 * });
 * ```
 */

// ─── Re-export Types ────────────────────────────────────────────

export type {
  Character,
  Dialogue,
  ScriptAct,
  Script,
  ScriptRequest,
  SceneType,
  RoleType,
  OasisAgentConfig,
  DramatizationConfig,
} from './types.js';

export { SceneTypeSchema, RoleTypeSchema } from './types.js';

// ─── Re-export Script Generator ─────────────────────────────────

export { ScriptGenerator, createScriptGenerator } from './script-generator.js';

// ─── Re-export OASIS Dramatizer ────────────────────────────────

export {
  OasisDramatizer,
  createOasisDramatizer,
  type OasisDramatizationConfig,
  type SimulationContext,
  type SimulationResult,
  type DramatizationOutput,
} from './oasis-dramatizer.js';

// ─── Re-export Adapter ──────────────────────────────────────────

export { ClassicTextDomainAdapter, ClassicTextDomainConfig, createClassicTextAdapter } from './adapter.js';

export { ClassicTextDomainConfig as ClassicTextDomain } from './adapter.js';

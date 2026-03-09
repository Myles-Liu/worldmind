/**
 * OpenClawRuntime — One OpenClaw sub-session per OASIS agent
 *
 * Each agent gets a full OpenClaw session with:
 * - Independent system prompt (persona + world context)
 * - Persistent conversational memory across rounds
 * - Full LLM reasoning per agent per round
 *
 * Uses OpenClaw's sessions_spawn / sessions_send API.
 * This is the most powerful but most expensive runtime.
 */

import {
  BaseAgentRuntime,
  type AgentPersona,
  type AgentSession,
  type RoundContext,
  type AgentDecision,
  type FeedItem,
} from './agent-runtime.js';

// ─── Types ──────────────────────────────────────────────────────

export interface OpenClawRuntimeConfig {
  /**
   * OpenClaw gateway URL. Defaults to local.
   */
  gatewayUrl?: string;

  /**
   * API token for OpenClaw gateway.
   */
  apiToken?: string;

  /**
   * Model to use for sub-sessions.
   * Defaults to process.env.WORLDMIND_LLM_MODEL
   */
  model?: string;

  /**
   * Timeout for each decide() call in seconds.
   */
  decideTimeoutSec?: number;

  /**
   * Max concurrent spawns (to avoid overwhelming the gateway).
   */
  maxConcurrentSpawns?: number;
}

interface OpenClawSession extends AgentSession {
  /** OpenClaw session key */
  sessionKey: string;
  /** Label used for sessions_send */
  label: string;
}

// ─── Implementation ─────────────────────────────────────────────

export class OpenClawRuntime extends BaseAgentRuntime {
  readonly name = 'openclaw';

  private config: Required<OpenClawRuntimeConfig>;
  private sessions: Map<string, OpenClawSession> = new Map();

  // OpenClaw API functions — injected to avoid hard dependency on OpenClaw SDK
  private api: OpenClawAPI;

  constructor(config: OpenClawRuntimeConfig, api: OpenClawAPI) {
    super();
    this.config = {
      gatewayUrl: config.gatewayUrl ?? 'http://localhost:18789',
      apiToken: config.apiToken ?? '',
      model: config.model ?? process.env.WORLDMIND_LLM_MODEL ?? 'gpt-4o-mini',
      decideTimeoutSec: config.decideTimeoutSec ?? 120,
      maxConcurrentSpawns: config.maxConcurrentSpawns ?? 5,
    };
    this.api = api;
  }

  async spawn(persona: AgentPersona, worldContext: string): Promise<AgentSession> {
    const label = `worldmind-agent-${persona.id}-${persona.username}`;

    const systemPrompt = this.buildSystemPrompt(persona, worldContext);

    const result = await this.api.sessionsSpawn({
      task: systemPrompt,
      label,
      mode: 'session',       // persistent session, not one-shot
      model: this.config.model,
    });

    const session: OpenClawSession = {
      agentId: persona.id,
      sessionId: result.sessionKey,
      persona,
      sessionKey: result.sessionKey,
      label,
    };

    this.sessions.set(session.sessionId, session);
    return session;
  }

  async decide(session: AgentSession, context: RoundContext): Promise<AgentDecision> {
    const oclawSession = this.sessions.get(session.sessionId);
    if (!oclawSession) {
      return { agentId: session.agentId, action: 'do_nothing', reasoning: 'session not found' };
    }

    const prompt = this.buildRoundPrompt(session.persona, context);

    const response = await this.api.sessionsSend({
      sessionKey: oclawSession.sessionKey,
      message: prompt,
      timeoutSeconds: this.config.decideTimeoutSec,
    });

    return this.parseDecision(session.agentId, response);
  }

  async onActionResult(session: AgentSession, decision: AgentDecision, success: boolean): Promise<void> {
    const oclawSession = this.sessions.get(session.sessionId);
    if (!oclawSession) return;

    // Brief feedback message so the agent's memory includes what happened
    const feedback = success
      ? `[System] Your action was executed: ${decision.action}${decision.content ? ` — "${decision.content.slice(0, 100)}"` : ''}`
      : `[System] Your action failed: ${decision.action}`;

    await this.api.sessionsSend({
      sessionKey: oclawSession.sessionKey,
      message: feedback,
      timeoutSeconds: 30,
    }).catch(() => {}); // non-critical
  }

  async destroy(session: AgentSession): Promise<void> {
    this.sessions.delete(session.sessionId);
    // OpenClaw sessions auto-cleanup; explicit kill if needed
  }

  async shutdownAll(): Promise<void> {
    this.sessions.clear();
  }

  // ─── Prompt Construction ────────────────────────────────────

  private buildSystemPrompt(persona: AgentPersona, worldContext: string): string {
    return `你是一个社交媒体上的真实用户。以下是你的身份和行为准则。

# 世界背景
${worldContext}

# 你的身份
- 用户名: @${persona.username}
- 角色: ${persona.role}
- 性格: ${persona.personality}

# 行为准则
- 你是一个真实的人，有自己的观点、情绪和记忆
- 基于你的性格和经历自然地参与社交媒体
- 记住之前发生的对话和互动，保持人设一致性
- 每轮你会收到当前的 feed 和通知，然后决定要做什么

# 决策输出格式
每次收到新一轮的 feed 后，用以下 JSON 格式回复你的决策：

\`\`\`json
{
  "action": "post" | "comment" | "like" | "follow" | "do_nothing",
  "content": "你要发布或评论的内容（如果是 post/comment）",
  "targetPostId": 123,
  "targetUserId": 456,
  "reasoning": "你做这个决策的原因（简短）"
}
\`\`\`

重要规则：
- 不要每轮都发帖，真实用户大部分时间在浏览和互动
- 评论和点赞应该多于发新帖
- 保持你的角色特色，不要模仿其他人的风格
- 只输出 JSON，不要多余的解释`;
  }

  private buildRoundPrompt(persona: AgentPersona, context: RoundContext): string {
    const parts: string[] = [];
    parts.push(`# 第 ${context.round} 轮`);

    // Feed
    if (context.feed.length > 0) {
      parts.push('\n## 📰 当前 Feed');
      for (const item of context.feed) {
        parts.push(`- [#${item.postId}] @${item.authorName}: ${item.content} (❤️${item.likes} 💬${item.comments})`);
      }
    } else {
      parts.push('\n## 📰 Feed 为空（还没有人发帖）');
    }

    // Notifications
    if (context.notifications.length > 0) {
      parts.push('\n## 🔔 通知');
      for (const n of context.notifications) {
        parts.push(`- ${n.fromAgent} ${n.type}: ${n.content}`);
      }
    }

    parts.push('\n请根据以上信息，以 JSON 格式回复你这一轮的决策。');

    return parts.join('\n');
  }

  // ─── Response Parsing ───────────────────────────────────────

  private parseDecision(agentId: number, response: string): AgentDecision {
    // Try to extract JSON from response
    const jsonMatch = response.match(/```json\s*([\s\S]*?)```/) ?? response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const raw = jsonMatch[1] ?? jsonMatch[0];
        const parsed = JSON.parse(raw);
        return {
          agentId,
          action: this.normalizeAction(parsed.action),
          content: parsed.content,
          targetPostId: parsed.targetPostId,
          targetUserId: parsed.targetUserId,
          reasoning: parsed.reasoning,
        };
      } catch {}
    }

    // Fallback: try to infer from text
    return { agentId, action: 'do_nothing', reasoning: 'failed to parse response' };
  }

  private normalizeAction(action: string): AgentDecision['action'] {
    const map: Record<string, AgentDecision['action']> = {
      post: 'post', create_post: 'post',
      comment: 'comment', create_comment: 'comment',
      like: 'like', like_post: 'like',
      follow: 'follow',
      repost: 'repost',
      do_nothing: 'do_nothing', nothing: 'do_nothing', skip: 'do_nothing',
    };
    return map[action?.toLowerCase()] ?? 'do_nothing';
  }
}

// ─── OpenClaw API abstraction ───────────────────────────────────

/**
 * Minimal API surface that OpenClawRuntime needs.
 * This allows the runtime to work without importing OpenClaw internals.
 * The orchestrator provides a concrete implementation.
 */
export interface OpenClawAPI {
  sessionsSpawn(params: {
    task: string;
    label: string;
    mode: 'run' | 'session';
    model?: string;
  }): Promise<{ sessionKey: string }>;

  sessionsSend(params: {
    sessionKey: string;
    message: string;
    timeoutSeconds?: number;
  }): Promise<string>;
}

/**
 * OpenClaw Gateway HTTP API client
 *
 * Implements the OpenClawAPI interface using the /tools/invoke HTTP endpoint.
 * This allows WorldMind to spawn and communicate with OpenClaw sub-sessions
 * without importing any OpenClaw internals.
 */

import type { OpenClawAPI } from './runtime-openclaw.js';

export interface OpenClawGatewayConfig {
  /** Gateway base URL, e.g. http://127.0.0.1:18789 */
  baseUrl: string;
  /** Auth token (gateway.auth.token) */
  token: string;
  /** Session key to invoke tools under. Default: "main" */
  sessionKey?: string;
}

export class OpenClawGatewayClient implements OpenClawAPI {
  private baseUrl: string;
  private token: string;
  private sessionKey: string;

  constructor(config: OpenClawGatewayConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token;
    this.sessionKey = config.sessionKey ?? 'main';
  }

  async sessionsSpawn(params: {
    task: string;
    label: string;
    mode: 'run' | 'session';
    model?: string;
  }): Promise<{ sessionKey: string }> {
    const result = await this.invokeTool('sessions_spawn', {
      task: params.task,
      label: params.label,
      mode: params.mode,
      model: params.model,
    });

    // sessions_spawn returns { status: "accepted", runId, childSessionKey }
    const parsed = typeof result === 'string' ? JSON.parse(result) : result;
    const sessionKey = parsed.childSessionKey ?? parsed.sessionKey ?? parsed.runId;

    if (!sessionKey) {
      throw new Error(`sessions_spawn returned no sessionKey: ${JSON.stringify(parsed)}`);
    }

    return { sessionKey };
  }

  async sessionsSend(params: {
    sessionKey: string;
    message: string;
    timeoutSeconds?: number;
  }): Promise<string> {
    const result = await this.invokeTool('sessions_send', {
      sessionKey: params.sessionKey,
      message: params.message,
      timeoutSeconds: params.timeoutSeconds ?? 120,
    });

    // sessions_send returns the assistant's response
    const parsed = typeof result === 'string' ? JSON.parse(result) : result;
    return parsed.response ?? parsed.message ?? parsed.content ?? JSON.stringify(parsed);
  }

  // ─── Internal ─────────────────────────────────────────────────

  private async invokeTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const url = `${this.baseUrl}/tools/invoke`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        tool,
        args,
        sessionKey: this.sessionKey,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenClaw API ${tool} failed (${response.status}): ${body}`);
    }

    const data = await response.json();
    return data;
  }
}

/**
 * Custom API Client
 * 
 * Custom 的认证方式与 OpenAI 不同：
 * appId 和 appKey 需要放在 request body 里，而不是 Authorization header。
 */

export interface CustomConfig {
  baseURL: string;
  appId: string;
  appKey: string;
  model: string;
  maxRetries?: number;
  timeout?: number;
}

function getDefaultConfig(): CustomConfig {
  return {
    baseURL: process.env['LLM_BASE_URL'] ?? 'https://api.openai.com/v1',
    appId: process.env['LLM_APP_ID'] ?? '',
    appKey: process.env['LLM_API_KEY'] ?? '',
    model: process.env['LLM_MODEL'] ?? 'aws.claude-opus-4.6',
    maxRetries: 3,
    timeout: 120_000,
  };
}

interface CustomMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface CustomResponse {
  status: number;
  message: string;
  data: {
    result: string;
    resultRole: string;
    choices: Array<{
      message: { content: string; role: string };
      index: number;
      finishReason: string;
    }>;
    usage: Record<string, number>;
  };
}

export class CustomLLMClient {
  private config: CustomConfig;

  constructor(config?: Partial<CustomConfig>) {
    this.config = { ...getDefaultConfig(), ...config };
  }

  private async callAPI(messages: CustomMessage[], temperature = 0.7, maxTokens = 4096): Promise<string> {
    const body = {
      appId: this.config.appId,
      appKey: this.config.appKey,
      model: this.config.model,
      messages,
      max_tokens: maxTokens,
      temperature,
    };

    let lastError: Error | null = null;
    const retries = this.config.maxRetries ?? 3;

    for (let i = 0; i < retries; i++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout ?? 120_000);

        const resp = await fetch(`${this.config.baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const data = await resp.json() as CustomResponse;

        if (data.status !== 0) {
          throw new Error(`Custom API error: ${data.message}`);
        }

        return data.data.result ?? data.data.choices?.[0]?.message?.content ?? '';
      } catch (e) {
        lastError = e as Error;
        if (i < retries - 1) {
          await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
      }
    }

    throw lastError;
  }

  async complete(systemPrompt: string, userMessage: string, options?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<string> {
    const messages: CustomMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];
    return this.callAPI(messages, options?.temperature ?? 0.7, options?.maxTokens ?? 4096);
  }

  async json<T>(systemPrompt: string, userMessage: string, options?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<T> {
    const content = await this.complete(
      `${systemPrompt}\n\nYou MUST respond with valid JSON only. No markdown, no code fences, no extra text.`,
      userMessage,
      { ...options, temperature: options?.temperature ?? 0.3 }
    );

    let cleaned = content.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    try {
      return JSON.parse(cleaned) as T;
    } catch (e) {
      console.error('[CustomLLM] JSON parse failed. Raw:', cleaned.substring(0, 500));
      throw e;
    }
  }

  get model(): string {
    return this.config.model;
  }
}

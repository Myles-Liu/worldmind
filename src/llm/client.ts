import OpenAI from 'openai';

// ─── Configuration ──────────────────────────────────────────────

export interface LLMConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  userId: string;
  maxRetries: number;
  timeout: number; // ms
}

function getDefaultConfig(): LLMConfig {
  return {
    baseURL: process.env['WORLDMIND_LLM_BASE_URL'] ?? 'https://api.openai.com/v1',
    apiKey: process.env['WORLDMIND_LLM_API_KEY'] ?? '',
    model: process.env['WORLDMIND_LLM_MODEL'] ?? 'gpt-4',
    userId: process.env['WORLDMIND_USER_ID'] ?? 'worldmind',
    maxRetries: 3,
    timeout: 120_000,
  };
}

// ─── LLM Client ─────────────────────────────────────────────────

export class LLMClient {
  private client: OpenAI;
  private config: LLMConfig;

  constructor(config?: Partial<LLMConfig>) {
    this.config = { ...getDefaultConfig(), ...config };
    this.client = new OpenAI({
      baseURL: this.config.baseURL,
      apiKey: this.config.apiKey,
      maxRetries: this.config.maxRetries,
      timeout: this.config.timeout,
      defaultHeaders: {
        'X-User-Id': this.config.userId,
      },
    });
  }

  /**
   * Simple completion — send messages, get a string back.
   * Uses streaming because the API server forces SSE responses.
   */
  async complete(
    systemPrompt: string,
    userMessage: string,
    options?: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
    },
  ): Promise<string> {
    const stream = await this.client.chat.completions.create({
      model: options?.model ?? this.config.model,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 4096,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });

    let content = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) content += delta;
    }
    return content.trim();
  }

  /**
   * Streaming completion — returns an async iterable of text chunks.
   */
  async *stream(
    systemPrompt: string,
    userMessage: string,
    options?: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
    },
  ): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create({
      model: options?.model ?? this.config.model,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 4096,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        yield delta;
      }
    }
  }

  /**
   * Structured output — get JSON back from the LLM.
   * Uses streaming and parses the collected content as JSON.
   */
  async json<T>(
    systemPrompt: string,
    userMessage: string,
    options?: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
    },
  ): Promise<T> {
    const stream = await this.client.chat.completions.create({
      model: options?.model ?? this.config.model,
      temperature: options?.temperature ?? 0.3,
      max_tokens: options?.maxTokens ?? 4096,
      stream: true,
      messages: [
        { role: 'system', content: `${systemPrompt}\n\nYou MUST respond with valid JSON only. No markdown, no code fences, no extra text.` },
        { role: 'user', content: userMessage },
      ],
    });

    let content = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) content += delta;
    }

    // Strip potential markdown code fences
    content = content.trim();
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    return JSON.parse(content) as T;
  }

  /**
   * Get the current model name.
   */
  get model(): string {
    return this.config.model;
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let _defaultClient: LLMClient | null = null;

export function getDefaultLLMClient(): LLMClient {
  if (!_defaultClient) {
    _defaultClient = new LLMClient();
  }
  return _defaultClient;
}

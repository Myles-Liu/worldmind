import type {
  Agent,
  AgentConfig,
  AgentContext,
  AgentOutput,
  PredictionFeedback,
} from '../types/agent.js';
import type { WorldEvent } from '../types/event.js';
import { LLMClient, getDefaultLLMClient } from '../llm/client.js';
import { AgentMemory } from '../memory/agent-memory.js';
import { SemanticMemory } from '../memory/semantic-memory.js';
import type { KnowledgeBase } from '../memory/knowledge-base.js';
import { getSoulLoader, type SoulLoader } from './soul-loader.js';
import { ContextComposer, type ContextSection } from '../llm/context-composer.js';
import { ContextEngine, type ContextItem } from '../llm/context-engine.js';
import type { SharedContextBus } from '../context/shared-bus.js';

// ─── Base Agent ─────────────────────────────────────────────────

export abstract class BaseAgent implements Agent {
  abstract readonly name: string;
  abstract readonly description: string;

  readonly config: AgentConfig;
  protected llm: LLMClient;
  protected context: AgentContext | null = null;

  /**
   * @deprecated Use `semanticMemory` instead. Retained for backward compatibility.
   */
  protected memory: AgentMemory;

  /** Semantic memory with TF-IDF retrieval and importance decay. */
  protected semanticMemory: SemanticMemory;

  protected knowledgeBase?: KnowledgeBase;
  protected soulLoader: SoulLoader;

  /**
   * @deprecated Use `contextEngine` instead. Retained for backward compatibility.
   */
  protected contextComposer: ContextComposer;

  /** Layered context engine — replaces ContextComposer. */
  protected contextEngine: ContextEngine;

  /** Shared context bus for inter-agent communication. */
  protected sharedBus: SharedContextBus | null = null;

  /** Domain-specific context injected into Layer 1. Set via setDomainContext(). */
  protected domainContext: string = '';

  private soulContent: string = '';

  // Agent's internal state — subclasses can use this for persistent memory
  protected state: Record<string, unknown> = {};

  constructor(config?: Partial<AgentConfig>) {
    this.config = {
      name: this.constructor.name,
      enabled: true,
      maxEventsPerCycle: 100,
      confidenceThreshold: 0.3,
      ...config,
    };
    this.llm = getDefaultLLMClient();
    this.soulLoader = getSoulLoader();
    this.contextComposer = new ContextComposer(3500);
    this.contextEngine = new ContextEngine(4000);
    // Memory is initialized with a placeholder; subclasses set `name` after super()
    // so we defer actual path construction to initialize()
    this.memory = new AgentMemory('_uninitialized_');
    this.semanticMemory = new SemanticMemory('_uninitialized_');
  }

  /**
   * Initialize agent — load memory from disk and soul from file.
   * Must be called before analyze().
   */
  async initialize(): Promise<void> {
    // Re-create memory with the actual agent name (subclass sets `name` after super)
    this.memory = new AgentMemory(this.name);
    await this.memory.load();

    this.semanticMemory = new SemanticMemory(this.name);
    await this.semanticMemory.load();

    this.soulContent = await this.soulLoader.load(this.name);
  }

  /**
   * Finalize agent — save memory to disk and run consolidation.
   * Must be called after analyze().
   */
  async finalize(): Promise<void> {
    // Run memory consolidation periodically to reduce redundancy
    this.semanticMemory.consolidate();

    await this.memory.save();
    await this.semanticMemory.save();
  }

  /**
   * Helper: get memory context for prompts.
   */
  protected getMemoryContext(): string {
    return this.memory.formatForPrompt();
  }

  /**
   * Set the knowledge base for domain knowledge injection.
   */
  setKnowledgeBase(kb: KnowledgeBase): void {
    this.knowledgeBase = kb;
  }

  /**
   * Set the shared context bus for inter-agent communication.
   */
  setSharedBus(bus: SharedContextBus): void {
    this.sharedBus = bus;
  }

  /**
   * Set domain-specific context for this agent.
   * Injected into Layer 1 (Identity) after the soul file.
   * 
   * Typically called by the pipeline runner using DomainConfig.agentContext[role].
   */
  setDomainContext(context: string): void {
    this.domainContext = context;
  }

  /**
   * Get knowledge context relevant to the given topics.
   */
  protected getKnowledgeContext(topics: string[]): string {
    if (!this.knowledgeBase) return '';
    return this.knowledgeBase.formatForPrompt(topics);
  }

  /**
   * Build a complete system prompt using the new ContextEngine.
   *
   * Populates all 5 layers:
   *   Layer 1 (Identity):       Soul file content + task description
   *   Layer 2 (World State):    WorldModel state + cross-agent briefings
   *   Layer 3 (Working Memory): Task-specific context + additional context
   *   Layer 4 (Long-term Memory): Semantically relevant past memories
   *   Layer 5 (Knowledge):      Domain knowledge + response format
   */
  protected buildSystemPrompt(options: {
    taskDescription: string;
    topics?: string[];
    additionalContext?: string;
    responseFormat?: string;
  }): string {
    // Reset the engine for this prompt
    this.contextEngine.clear();

    // ── Layer 1: Identity (always present, never compressed) ─────
    const identityParts: string[] = [];
    if (this.soulContent) {
      identityParts.push(this.soulContent);
    }
    // Domain-specific context (from DomainConfig.agentContext)
    if (this.domainContext) {
      identityParts.push(`\nDomain context:\n${this.domainContext}`);
    }
    // Temporal awareness — agents know when they are
    const now = new Date();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    identityParts.push(`\nTemporal context:`);
    identityParts.push(`  Current time: ${now.toISOString()}`);
    identityParts.push(`  Day of week: ${dayNames[now.getUTCDay()]}`);
    identityParts.push(`  This matters: weekend activity patterns differ from weekdays; recent events (<48h) carry more weight than older ones.`);

    identityParts.push(`\nCurrent task: ${options.taskDescription}`);
    if (options.responseFormat) {
      identityParts.push(`\nYou MUST respond with valid JSON only. No markdown, no code fences, no extra text.\n\n${options.responseFormat}`);
    }
    this.contextEngine.setLayerText(1, identityParts.join('\n'));

    // ── Layer 2: World State (high priority, summarized) ─────────
    const worldParts: string[] = [];

    // World model context from shared bus
    if (this.sharedBus) {
      const worldContext = this.sharedBus.getWorldContext();
      if (worldContext) {
        worldParts.push(worldContext);
      }

      // Cross-agent briefings
      const briefing = this.sharedBus.getAgentBriefing(this.name);
      if (briefing) {
        worldParts.push(briefing);
      }
    }

    if (worldParts.length > 0) {
      this.contextEngine.setLayerText(2, worldParts.join('\n\n'));
    }

    // ── Layer 3: Working Memory (dynamic, task-specific) ─────────
    const workingItems: ContextItem[] = [];

    if (options.additionalContext) {
      workingItems.push({
        id: 'additional-context',
        content: options.additionalContext,
        importance: 0.7,
        timestamp: new Date().toISOString(),
      });
    }

    if (workingItems.length > 0) {
      this.contextEngine.setLayerItems(3, workingItems);
    }

    // ── Layer 4: Long-term Memory ─────────────────────────────────
    // ONLY inject "lesson" type memories. Observations, predictions,
    // and reflections from previous cycles are noise — the current
    // cycle's data comes through SharedContextBus (Layer 3).
    const lessons = this.semanticMemory.getByType('lesson', 3)
      .map(m => ({
        id: m.id,
        content: `[lesson] ${m.content}`,
        importance: m.importance,
        timestamp: m.timestamp,
      }));
    if (lessons.length > 0) {
      this.contextEngine.setLayerItems(4, lessons);
    }

    // ── Layer 5: Knowledge (injected ONLY when genuinely relevant) ──
    // Filter topics to domain-level terms only (not repo names, not languages)
    // Knowledge should be injected rarely — most analysis cycles don't need it
    if (options.topics && options.topics.length > 0) {
      const domainTopics = options.topics.filter(t =>
        // Keep broad domain terms, filter out specific repo names and common languages
        !t.includes('/') && // repo names like "owner/repo"
        t.length > 2 &&
        !/^(typescript|javascript|python|rust|go|java|c\+\+|ruby|swift|kotlin|dart|css|html|shell|lua)$/i.test(t)
      );
      if (domainTopics.length > 0) {
        const knowledgeContent = this.getKnowledgeContext(domainTopics);
        if (knowledgeContent) {
          this.contextEngine.setLayerText(5, knowledgeContent, 0.85);
        }
      }
    }

    // Compose and return
    const { prompt } = this.contextEngine.compose();
    return prompt;
  }

  /**
   * Set the agent context for this analysis cycle.
   */
  setContext(context: AgentContext): void {
    this.context = context;
  }

  /**
   * Core analysis — subclasses must implement.
   */
  abstract analyze(events: WorldEvent[]): Promise<AgentOutput[]>;

  /**
   * Produce a concise briefing of this agent's outputs for downstream agents.
   * The SharedContextBus calls this after the agent finishes.
   *
   * Default implementation summarizes the agent's outputs.
   * Subclasses can override for custom briefing formats.
   */
  briefOtherAgents(outputs: AgentOutput[]): string {
    if (outputs.length === 0) {
      return `${this.name} Agent: No significant findings this cycle.`;
    }

    const summaries = outputs
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5)
      .map(o => `• [${o.outputType}] ${o.reasoning} (conf: ${Math.round(o.confidence * 100)}%)`);

    return `${this.name} Agent (${outputs.length} output${outputs.length > 1 ? 's' : ''}):\n${summaries.join('\n')}`;
  }

  /**
   * Receive feedback on past predictions.
   * Default implementation logs feedback; subclasses can override for custom learning.
   */
  async reflect(feedback: PredictionFeedback[]): Promise<void> {
    if (feedback.length === 0) return;

    // Store feedback as lessons in semantic memory
    for (const fb of feedback) {
      this.semanticMemory.add({
        cycle: 0,
        type: 'lesson',
        content: `Prediction feedback: ${fb.predictionId} was ${fb.outcome}. ${fb.notes ?? ''}`,
        importance: fb.outcome === 'incorrect' ? 0.9 : 0.6,
      });
    }
  }

  /**
   * Return the memory keys this agent needs.
   * Default: agent-specific state key.
   */
  getMemoryKeys(): string[] {
    return [`agent:${this.name}:state`];
  }

  /**
   * Generate a natural language summary of the agent's state.
   */
  async summarizeState(): Promise<string> {
    return `Agent "${this.name}" — ${this.description}. State entries: ${Object.keys(this.state).length}. Memories: ${this.semanticMemory.size}`;
  }

  // ─── Protected Helpers ──────────────────────────────────────────

  /**
   * Filter events to only those this agent should process.
   * Subclasses can override.
   */
  protected filterEvents(events: WorldEvent[]): WorldEvent[] {
    return events.slice(-this.config.maxEventsPerCycle);
  }

  /**
   * Create a standard AgentOutput object.
   */
  protected createOutput(
    outputType: string,
    data: Record<string, unknown>,
    confidence: number,
    reasoning: string,
    relatedEntities: string[] = [],
    summary?: string,
  ): AgentOutput {
    return {
      agentName: this.name,
      outputType,
      data,
      confidence,
      reasoning,
      summary: summary ?? this.autoSummary(outputType, data, confidence),
      timestamp: new Date().toISOString(),
      relatedEntities,
    };
  }

  /**
   * Auto-generate a one-line summary from output data.
   * Subclasses can override for domain-specific summaries.
   */
  protected autoSummary(
    outputType: string,
    data: Record<string, unknown>,
    confidence: number,
  ): string {
    const target = (data['repo'] ?? data['target'] ?? data['technology'] ?? '') as string;
    const conf = Math.round(confidence * 100);
    return `[${outputType}] ${target} (${conf}%)`.trim();
  }

  /**
   * Helper: add a memory to both the legacy memory and semantic memory.
   * Keeps them in sync during the migration period.
   */
  protected addMemory(entry: {
    cycle: number;
    type: string;
    content: string;
    importance: number;
    data?: Record<string, unknown>;
  }): void {
    this.memory.add(entry);
    this.semanticMemory.add(entry);
  }
}

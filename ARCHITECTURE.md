# WorldMind — Architecture

> A multi-agent world model engine that continuously perceives, models, reasons about, and predicts the evolution of complex ecosystems.

---

## 1. Project Overview

### What is WorldMind?

WorldMind is an **autonomous intelligence system** that maintains a living mental model of a domain — observing changes in real time, building structured memory, running multi-agent reasoning, and producing **verifiable predictions**.

Unlike traditional analytics dashboards that show you what *happened*, WorldMind tells you what *will happen* — and keeps score on whether it was right.

### Core Loop

```
Perceive → Remember → Reason → Predict → Verify → Learn
    ↑                                           │
    └───────────────────────────────────────────┘
```

1. **Perceive**: Continuously ingest events from the target domain
2. **Remember**: Store entities, relationships, and events in a temporal knowledge graph
3. **Reason**: Multiple specialized agents analyze different dimensions
4. **Predict**: Synthesize agent outputs into verifiable predictions
5. **Verify**: Check past predictions against reality
6. **Learn**: Feed accuracy data back to calibrate agents

### First Target: GitHub Open Source Ecosystem

The initial validation domain is the GitHub open source ecosystem — a rich, publicly observable, fast-moving world with:

- Clear entities (repos, developers, organizations)
- Observable signals (stars, forks, commits, issues)
- Measurable outcomes (adoption curves, community growth)
- Temporal dynamics (trends emerge, peak, and fade)

### Long-term Vision

The architecture is domain-agnostic. The same perception → memory → reasoning → prediction pipeline can be adapted to:

- **Public opinion / media** — tracking narrative shifts and viral content
- **Finance** — monitoring market sentiment and project health
- **Physical spaces / embodied AI** — modeling environments for autonomous agents
- **Enterprise ecosystems** — understanding internal organizational dynamics

---

## 2. Core Architecture

```
┌──────────────────────────────────────────────────┐
│                    WorldMind                       │
├──────────────────────────────────────────────────┤
│  Perception Layer (感知层)                         │
│  ├── Data Collectors (GitHub API, RSS, etc.)      │
│  └── Event Stream (标准化事件流)                   │
├──────────────────────────────────────────────────┤
│  Memory Layer (记忆层)                             │
│  ├── Short-term: Recent events buffer             │
│  ├── Long-term: Temporal GraphRAG                 │
│  └── Entity Store: 实体档案 (项目/人/组织)         │
├──────────────────────────────────────────────────┤
│  Agent Layer (智能体层)                            │
│  ├── Trend Agent: 趋势发现                        │
│  ├── Network Agent: 关系图谱                      │
│  ├── Tech Agent: 技术演变追踪                     │
│  ├── Predict Agent: 综合推理预测                  │
│  └── Challenge Agent: 质疑验证                    │
├──────────────────────────────────────────────────┤
│  World Model (世界模型层)                          │
│  ├── Entity Graph: 实体关系图                     │
│  ├── Temporal Index: 时序索引                     │
│  └── Belief State: 当前世界状态信念               │
├──────────────────────────────────────────────────┤
│  Output Layer (输出层)                             │
│  ├── Predictions: 可验证的预测                    │
│  ├── Reports: 世界状态报告                        │
│  └── API: 外部查询接口                            │
└──────────────────────────────────────────────────┘
```

### Layer Responsibilities

| Layer | Role | Key Principle |
|-------|------|---------------|
| **Perception** | Convert raw data sources into standardized events | Source-agnostic; all data becomes `WorldEvent` |
| **Memory** | Store, index, and retrieve entities and their history | Temporal-first; every fact has a timestamp |
| **Agent** | Analyze specific dimensions and produce insights | Single-responsibility; agents collaborate but don't duplicate |
| **World Model** | Maintain a coherent belief about the current state | Uncertainty-aware; beliefs have confidence scores |
| **Output** | Render predictions and reports for consumption | Verifiable; every prediction has a check date |

---

## 3. Agent Detailed Design

### 3.1 Design Principles

Every agent in WorldMind follows these principles:

- **Single Responsibility**: Each agent owns one analytical dimension
- **Event-Driven**: Agents react to events, not polling loops
- **Memory-Backed**: Agents remember past analyses and their accuracy
- **Collaborative**: Agents read each other's outputs through the shared event log
- **Self-Calibrating**: Prediction accuracy feeds back into future confidence

### 3.2 Agent Interface

All agents implement a common interface:

```typescript
interface Agent {
  name: string;
  description: string;

  // Core lifecycle
  analyze(events: WorldEvent[]): Promise<AgentOutput[]>;
  reflect(feedback: PredictionFeedback[]): Promise<void>;

  // Memory
  getMemoryKeys(): string[];
  summarizeState(): Promise<string>;
}
```

### 3.3 Trend Agent

**Mission**: Be the first to notice when something unusual is happening.

| Aspect | Detail |
|--------|--------|
| **Responsibility** | Continuously monitor GitHub trending data, newly created repos, and repos with abnormal star growth patterns |
| **Input Data** | GitHub API: trending repos, search results (sorted by stars/updated), public events stream |
| **Reasoning Strategy** | Statistical anomaly detection + LLM qualitative assessment. Specifically: (1) Calculate star velocity (stars/day) and acceleration (change in velocity). (2) Compare fork-to-star ratio against domain baselines. (3) Analyze contributor profiles — are they established developers or new accounts? (4) Use LLM to assess repo quality signals (README quality, code structure, license, CI setup). |
| **Output Format** | `TrendSignal { repo, signalType, confidence, reasoning, metrics, detectedAt }` |
| **Memory Strategy** | **Remember**: Past signals and whether they led to sustained growth or fizzled. Historical star velocity baselines per category. **Forget**: Raw API response data after processing. Individual event details older than 30 days. |
| **Agent Interactions** | → Publishes `TrendSignal` events consumed by **Predict Agent**. ← Receives `TechCategoryUpdate` from **Tech Agent** to contextualize trends within technology domains. ← Receives `PredictionFeedback` to calibrate confidence thresholds. |

**Key Heuristics**:
- A repo gaining >100 stars/day from its first week is a strong early signal
- Repos starred by known "tastemakers" (identified by Network Agent) deserve attention even at low absolute numbers
- Sudden contributor influx from diverse organizations suggests organic adoption, not hype

### 3.4 Network Agent

**Mission**: Understand *who* matters and *how* they're connected.

| Aspect | Detail |
|--------|--------|
| **Responsibility** | Build and maintain a developer/project relationship graph. Identify key opinion leaders, community structures, and cross-community bridges. |
| **Input Data** | GitHub user follow/star/contribution data. PR reviews and issue discussions. Organization membership. |
| **Reasoning Strategy** | Graph analysis + LLM interpretation. (1) Compute centrality metrics (PageRank, betweenness) to identify influential nodes. (2) Community detection via modularity clustering. (3) Track "bridge" developers who contribute across communities. (4) LLM assesses qualitative influence — who do other influential people defer to? |
| **Output Format** | `GraphUpdate { updateType, entities[], relationships[], communityChanges[], timestamp }` |
| **Memory Strategy** | **Remember**: The full relationship graph (this IS the memory — it's the core artifact). Community membership snapshots at weekly intervals. Key influence metrics over time. **Forget**: Transient follow/unfollow events that don't change community structure. One-time interactions (single comment on a random issue). |
| **Agent Interactions** | → Publishes `InfluencerActivity` events consumed by **Trend Agent** (tastemaker signals). → Publishes `CommunityStructure` updates consumed by **Predict Agent**. ← Receives `TrendSignal` from **Trend Agent** to track which communities are rallying around trending repos. |

**Key Metrics**:
- **Influence Score**: Weighted combination of followers, contribution impact, and "follow-back ratio" from other influential developers
- **Community Cohesion**: How tightly connected are members? High cohesion = stable; fragmenting = potential fork/split
- **Bridge Score**: Developers who connect otherwise disconnected communities are disproportionately important for technology diffusion

### 3.5 Tech Agent

**Mission**: Track the lifecycle of technologies, frameworks, and paradigms.

| Aspect | Detail |
|--------|--------|
| **Responsibility** | Monitor technology adoption curves, migration patterns, and emerging/declining tech stacks. |
| **Input Data** | `package.json` / `requirements.txt` / `go.mod` dependency analysis across repos. Issue and discussion keyword analysis. README technology mentions. GitHub Topics and language statistics. |
| **Reasoning Strategy** | Adoption curve modeling + LLM trend synthesis. (1) Track dependency graph changes — which packages are being added/removed across repos? (2) Identify migration patterns (e.g., "repos dropping Library A and adding Library B"). (3) Detect "tech debt signals" — increasing issues mentioning "migrate", "deprecate", "replace". (4) Map technologies to lifecycle stages: emerging → growing → mature → declining. |
| **Output Format** | `TechTrend { technology, lifecycle_stage, adoption_velocity, migration_signals[], competing_techs[], confidence }` |
| **Memory Strategy** | **Remember**: Full technology lifecycle timelines. Migration event history. Dependency popularity snapshots (monthly). **Forget**: Individual repo dependency lists (aggregate stats suffice). Unchanged technology states (only record transitions). |
| **Agent Interactions** | → Publishes `TechCategoryUpdate` consumed by **Trend Agent** to contextualize trending repos. → Publishes `TechTrend` consumed by **Predict Agent** for technology trajectory predictions. ← Receives `GraphUpdate` from **Network Agent** to understand which communities drive adoption. |

**Lifecycle Model**:
```
Emerging ──→ Growing ──→ Mature ──→ Declining
   │             │          │           │
   └── (dies) ───┘          └── (revival possible)
```

### 3.6 Predict Agent

**Mission**: Synthesize all signals into concrete, verifiable predictions.

| Aspect | Detail |
|--------|--------|
| **Responsibility** | Combine insights from all other agents to form specific, time-bound, verifiable predictions about the ecosystem. |
| **Input Data** | All outputs from Trend, Network, and Tech agents. Historical prediction accuracy data. Current world model belief state. |
| **Reasoning Strategy** | Multi-signal synthesis via LLM with structured prompting. (1) Gather relevant signals from all agents for a given entity/topic. (2) Identify convergent signals (multiple agents pointing same direction = higher confidence). (3) Apply base rates from historical prediction accuracy. (4) Generate specific, measurable, time-bound predictions. (5) Assign confidence with explicit reasoning chain. |
| **Output Format** | `Prediction { id, prediction_text, confidence, evidence[], timeframe, verification_criteria, category, created_at }` |
| **Memory Strategy** | **Remember**: ALL historical predictions and their verification results. Confidence calibration data (predicted X% confidence → actual Y% accuracy). Which types of predictions are reliable vs. unreliable. **Forget**: Nothing — prediction history is the most valuable dataset for self-improvement. |
| **Agent Interactions** | ← Consumes outputs from ALL other agents. → Publishes `Prediction` events consumed by **Challenge Agent**. ← Receives `ChallengeReport` from **Challenge Agent** — may revise or withdraw predictions. → Publishes finalized predictions to **Output Layer**. |

**Prediction Categories**:
- **Growth**: "Repo X will reach N stars by date Y"
- **Adoption**: "Technology A will surpass Technology B in weekly downloads by Q"
- **Community**: "Developer X will start contributing to project Y"
- **Decline**: "Framework Z will see >30% drop in new adoption"
- **Emergence**: "A new project in domain D will emerge and reach 1k stars within N weeks"

### 3.7 Challenge Agent

**Mission**: Be the professional skeptic. Every prediction must survive scrutiny.

| Aspect | Detail |
|--------|--------|
| **Responsibility** | Critically examine every prediction from Predict Agent. Find counter-evidence, logical flaws, and data biases. |
| **Input Data** | Predictions from Predict Agent. Independent access to all data sources. Historical accuracy data (especially failures). |
| **Reasoning Strategy** | Adversarial reasoning via LLM. (1) For each prediction, actively search for counter-evidence. (2) Check for common cognitive biases: recency bias, survivorship bias, hype cycle effects. (3) Verify that evidence actually supports the conclusion (correlation ≠ causation). (4) Check base rates — is this prediction significantly different from random chance? (5) Look for confounding factors the Predict Agent may have missed. |
| **Output Format** | `ChallengeReport { target_prediction_id, verdict, counter_evidence[], logical_issues[], bias_flags[], revised_confidence, reasoning }` |
| **Memory Strategy** | **Remember**: Which prediction *types* are most error-prone. Common failure modes and their signatures. Effective challenge strategies (what kinds of scrutiny actually catch errors). **Forget**: Predictions that passed challenge with flying colors (they're fine — focus on the failures). |
| **Agent Interactions** | ← Receives `Prediction` events from **Predict Agent**. → Publishes `ChallengeReport` back to **Predict Agent**. → May trigger prediction revision or withdrawal. → Publishes challenge results to **Output Layer** (transparency). |

**Challenge Checklist**:
1. Is the evidence sufficient? (not just cherry-picked signals)
2. Is the timeframe realistic? (not too vague, not impossibly precise)
3. Could the opposite happen? (what would need to be true?)
4. Are we pattern-matching on noise? (small sample size concerns)
5. Is there a simpler explanation? (Occam's razor)

---

## 4. Memory System Design

The memory system is the **heart** of WorldMind. Without persistent, structured, temporally-indexed memory, the agents are just stateless LLM calls. With it, they become entities with history, context, and the ability to learn.

### 4.1 Entity Store

Every entity (repo, user, organization) in WorldMind's awareness has a structured profile:

```typescript
interface EntityProfile {
  id: string;                          // e.g., "repo:facebook/react"
  type: EntityType;                    // 'repo' | 'user' | 'organization'
  name: string;
  metadata: Record<string, unknown>;   // Type-specific fields
  timeline: TimelineEvent[];           // Chronological history
  relationships: Relationship[];       // Current connections
  agentAnnotations: AgentAnnotation[]; // Agent impressions & assessments
  firstSeen: string;                   // ISO timestamp
  lastUpdated: string;
  version: number;                     // Incremented on each update
}
```

**Design Decisions**:
- Profiles are **append-oriented**: new events and annotations are added, old ones are rarely modified
- **Version history** is maintained to support "what did we know at time T?" queries
- Agent annotations are **attributed**: every assessment is tagged with which agent wrote it and when
- Profiles are stored as individual JSON files: `data/entities/{type}/{id}.json`

### 4.2 Event Log

All observations and agent outputs flow through a unified event log:

```typescript
interface WorldEvent {
  id: string;                    // UUID
  timestamp: string;             // ISO 8601
  type: EventType;               // Enumerated event types
  source: EventSource;           // 'collector:github' | 'agent:trend' | etc.
  entities: string[];            // Entity IDs involved
  data: Record<string, unknown>; // Event-specific payload
  importance: number;            // 0-1, for prioritizing agent attention
}
```

**Storage Strategy**:
- Events are appended to daily log files: `data/events/YYYY-MM-DD.jsonl`
- JSONL format for efficient append and line-by-line streaming
- An in-memory index maintains the last N events for quick access (short-term memory)
- Events older than 90 days are summarized and archived (only high-importance events retained verbatim)

### 4.3 Temporal Graph

The temporal knowledge graph captures how relationships between entities evolve over time:

```
Node: Entity (repo, user, org)
Edge: Relationship (type, weight, metadata)
Time: Every edge has [validFrom, validTo?] timestamps
```

**Capabilities**:
- **Point-in-time query**: "What was the relationship between React and Vue's contributor communities on 2024-01-15?"
- **Temporal diff**: "How has this developer's contribution focus shifted over the past 3 months?"
- **Path query**: "What's the shortest connection between Developer A and Project B?"
- **Community detection**: "Which repos form a tightly connected cluster?"

**MVP Implementation**:
- In-memory adjacency list with temporal annotations
- Serialized to `data/graph/graph.json` on each update cycle
- Future: migrate to Neo4j or similar for production scale

### 4.4 Belief State

The belief state is the agents' collective understanding of "how the world is right now":

```typescript
interface BeliefState {
  lastUpdated: string;
  beliefs: Belief[];
  worldSummary: string;        // Natural language summary
  confidenceOverall: number;   // How confident are we in our model?
}

interface Belief {
  subject: string;             // Entity or topic
  belief: string;              // Natural language statement
  confidence: number;          // 0-1
  supportingEvidence: string[];
  lastChallenged: string;      // When was this belief last scrutinized?
  agentSource: string;         // Which agent established this belief?
}
```

**Update Protocol**:
1. Each agent proposes belief updates based on new information
2. Conflicting beliefs trigger a deliberation (Predict + Challenge agents)
3. Belief confidence decays over time without reinforcing evidence
4. The world summary is regenerated after each update cycle

---

## 5. Technology Choices

| Component | MVP Choice | Rationale | Future Option |
|-----------|-----------|-----------|---------------|
| **Language** | TypeScript | Frontend team strength; dashboard synergy; excellent type system for complex domain models | — |
| **Runtime** | Node.js + tsx | Fast iteration; no compilation step for dev; native ESM | Bun (performance) |
| **LLM** | OpenAI-compatible API | Vendor-agnostic via env config; supports any model behind a compatible endpoint | Multi-model routing |
| **Graph DB** | In-memory + JSON files | Zero infrastructure; good enough for MVP data volume | Neo4j, Memgraph |
| **Vector Store** | Simple cosine similarity | Minimal dependency; sufficient for <10k entities | Chroma, Pinecone |
| **Scheduling** | setInterval loop | No infrastructure needed | BullMQ, node-cron |
| **GitHub API** | @octokit/rest | Official SDK; typed; handles rate limiting | GraphQL API for complex queries |
| **Schema Validation** | Zod | Runtime validation + TypeScript type inference in one | — |
| **CLI Output** | Chalk | Beautiful terminal output with minimal API | Ink (React for CLI) |

### LLM Configuration

The LLM client is configured via environment variables with sensible defaults:

```
WORLDMIND_LLM_BASE_URL=https://api.openai.com/v1
WORLDMIND_LLM_API_KEY=sk-your-api-key-here
WORLDMIND_LLM_MODEL=gpt-4
WORLDMIND_USER_ID=worldmind
```

All LLM calls go through a unified client that handles:
- Streaming responses (for long analysis tasks)
- Retry with exponential backoff
- Rate limiting
- Request/response logging for debugging
- Custom headers (`X-User-Id`)

---

## 6. MVP Scope

### Phase 1 — Foundation (Week 1)

- [x] Project skeleton and type definitions
- [ ] GitHub Data Collector (trending + basic search API)
- [ ] Simple Entity Store (JSON file-based)
- [ ] Trend Agent (minimal: identify repos with abnormal star velocity)
- [ ] CLI output: print discovered trend signals on each run

**Success Criteria**: Run `npx tsx src/index.ts` → see a list of trending repos with anomaly scores and LLM-generated reasoning.

### Phase 2 — Multi-Agent Reasoning (Week 2)

- [ ] Network Agent (developer relationship graph)
- [ ] Predict Agent (synthesize multi-agent signals)
- [ ] Challenge Agent (adversarial review)
- [ ] Prediction log + verification mechanism

**Success Criteria**: System produces specific predictions with confidence scores, and Challenge Agent visibly improves prediction quality.

### Phase 3 — Visualization & Automation (Week 3)

- [ ] Web Dashboard (visualize agent reasoning and world model)
- [ ] Temporal GraphRAG
- [ ] Automated daily run + report generation

**Success Criteria**: Daily automated report delivered via API/CLI; dashboard shows entity graph and prediction history.

---

## 7. Data Flow

### Single Cycle (Detailed)

```
                    ┌──────────────┐
                    │  GitHub API  │
                    └──────┬───────┘
                           │
                           ▼
                 ┌─────────────────┐
                 │ Data Collector   │
                 │ (perception)     │
                 └────────┬────────┘
                          │ WorldEvent[]
                          ▼
                 ┌─────────────────┐
                 │   Event Log     │──→ Persisted to data/events/
                 └────────┬────────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │  Trend   │ │ Network  │ │   Tech   │
        │  Agent   │ │  Agent   │ │  Agent   │
        └────┬─────┘ └────┬─────┘ └────┬─────┘
             │             │             │
             └──────┬──────┴─────────────┘
                    │ Agent outputs (events)
                    ▼
             ┌─────────────┐
             │   Predict   │
             │    Agent    │
             └──────┬──────┘
                    │ Prediction
                    ▼
             ┌─────────────┐
             │  Challenge  │
             │    Agent    │
             └──────┬──────┘
                    │ Challenged/Approved Prediction
                    ▼
             ┌─────────────┐
             │   Output    │──→ CLI / Report / API
             │    Layer    │
             └─────────────┘
                    │
                    ▼ (after timeframe elapses)
             ┌─────────────┐
             │  Validator   │──→ Feeds accuracy back to all agents
             └─────────────┘
```

### Example Trace

1. **t=0**: Data Collector queries GitHub trending API → discovers `awesome-newlib` gained 500 stars in 24h
2. **t=0**: Event `{ type: 'repo_trending', entities: ['repo:user/awesome-newlib'], data: { stars_24h: 500 } }` written to log
3. **t=1**: Trend Agent processes event → star velocity is 3σ above baseline for this category → emits `TrendSignal { confidence: 0.78, signalType: 'star_anomaly' }`
4. **t=1**: Network Agent notes: 3 of the stargazers are high-influence developers (PageRank > 0.8) → emits `InfluencerActivity`
5. **t=2**: Predict Agent combines signals → "awesome-newlib will reach 5,000 stars within 14 days" (confidence: 0.65)
6. **t=2**: Challenge Agent reviews → "Similar projects in this category average 60% hype-then-fade. Counter-evidence: the contributor has no prior successful projects. Revised confidence: 0.42"
7. **t=2**: Final prediction logged with confidence 0.42
8. **t=14d**: Validator checks → awesome-newlib has 4,200 stars → "Partially correct" → feedback fed to all agents

---

## 8. Directory Structure

```
worldmind/
├── ARCHITECTURE.md              # This document
├── README.md                    # Project introduction
├── package.json                 # Dependencies and scripts
├── tsconfig.json                # TypeScript configuration
├── src/
│   ├── index.ts                 # Entry point — orchestrates the full cycle
│   ├── types/
│   │   ├── entity.ts            # Entity types (repo, user, org)
│   │   ├── event.ts             # Event types and event stream
│   │   ├── agent.ts             # Agent interface and common types
│   │   └── prediction.ts        # Prediction and verification types
│   ├── collectors/
│   │   └── github.ts            # GitHub data collection via Octokit
│   ├── memory/
│   │   ├── entity-store.ts      # Entity profile CRUD + versioning
│   │   ├── event-log.ts         # Event append + query + archival
│   │   └── graph.ts             # In-memory temporal graph
│   ├── agents/
│   │   ├── base-agent.ts        # Abstract base class for all agents
│   │   ├── trend.ts             # Trend detection agent
│   │   ├── network.ts           # Network/relationship analysis agent
│   │   ├── tech.ts              # Technology lifecycle tracking agent
│   │   ├── predict.ts           # Prediction synthesis agent
│   │   └── challenge.ts         # Adversarial challenge agent
│   ├── world-model/
│   │   └── belief-state.ts      # World belief state management
│   ├── llm/
│   │   └── client.ts            # OpenAI-compatible LLM client (streaming)
│   └── output/
│       ├── cli.ts               # Terminal output formatting
│       └── report.ts            # Report generation
├── data/                        # Runtime data (gitignored)
│   ├── entities/                # Entity profiles (JSON)
│   ├── events/                  # Event logs (JSONL, daily files)
│   ├── predictions/             # Prediction records (JSON)
│   └── graph/                   # Graph snapshots (JSON)
└── scripts/
    └── validate.ts              # Prediction validation script
```

---

## Appendix A: Design Inspirations

- **MiroFish Temporal GraphRAG**: Time-indexed knowledge graphs where relationships have validity windows
- **OpenClaw Memory System**: Entity stores with agent annotations and version history
- **Prediction Markets**: The emphasis on verifiable, time-bound predictions with tracked accuracy
- **Adversarial Collaboration**: The Challenge Agent is inspired by red-teaming and pre-mortem analysis practices

## Appendix B: Future Considerations

- **Multi-domain support**: Abstract the Perception Layer so new domains (npm, HackerNews, ArXiv) plug in as collectors
- **Real-time streaming**: Replace polling with GitHub webhooks or streaming APIs
- **Distributed agents**: Run agents as separate processes/services for scalability
- **Human-in-the-loop**: Allow humans to inject beliefs, correct predictions, and guide agent attention
- **Embedding-based retrieval**: Use vector embeddings for semantic search across the event log and entity store

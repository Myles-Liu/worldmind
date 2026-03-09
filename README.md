# 🌍 WorldMind

**A multi-agent world model engine — watch, learn, predict, verify.**

> *"Build an AI that learns from the world, then prove it right."*

WorldMind is a reasoning engine powered by 5 specialized AI agents that continuously observe a domain (starting with GitHub open source), build an internal model, and make verifiable predictions.

## ✨ Why This Matters

Most AI systems are **consumers** of information. WorldMind is a **producer**:

1. **Observes** — Monitors new repos, HN mentions, network relationships
2. **Models** — Builds a structured world model from signals
3. **Predicts** — Makes concrete, time-bound, verifiable claims
4. **Verifies** — Checks past predictions against reality
5. **Learns** — Adjusts based on what it got right/wrong

The prediction loop closes in days, not months. [Try it yourself.](#quick-start)

## 🧠 Architecture

WorldMind separates the **generic engine** from **domain-specific adapters**.

```
┌─────────────────────────────────────────────────────────────────┐
│                      WorldModel Engine                          │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  Context Engine (5 layers)  │  SharedContextBus           │ │
│  │  Knowledge Base             │  Semantic Memory (TF-IDF)   │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  Agent Pipeline                                           │ │
│  │  Observe → Analyze → Predict → Challenge → Revise         │ │
│  └───────────────────────────────────────────────────────────┘ │
└────────────────────────────┬────────────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │  GitHub  │  │  Crypto  │  │  Custom  │
        │ Adapter  │  │ Adapter  │  │ Adapter  │
        └──────────┘  └──────────┘  └──────────┘
         5 agents       (yours)       (yours)
         3 collectors
```

### GitHub Domain (Built-in)

```
Trend Agent → Network Agent ─┐
               Tech Agent  ──┤
                              ▼
                        Predict Agent
                              │
                        Challenge Agent ← "Attack every prediction"
                              │
                        Round 2 Revision ← Accept valid challenges
```

### Context Engine (5 Layers)

Each agent sees the world through 5 context layers — inspired by [Anthropic's context engineering principles](docs/anthropic-context-engineering-notes.md):

| Layer | Purpose | Typical Size |
|-------|---------|--------------|
| **Identity** | Who you are + task | 800t |
| **World State** | What's happening now | 600t |
| **Working Memory** | What you need for this task | 1200t |
| **Long-term Memory** | Lessons from past cycles | 500t |
| **Knowledge** | Domain facts (calibration, trends) | 400t |

**Key insight**: Give only *just enough* context. Signal-to-noise ratio matters more than token count.

## 🚀 Quick Start

### As a Library

```ts
import { WorldModel, GitHubDomainAdapter } from 'worldmind';

// Use the built-in GitHub domain
const world = new WorldModel({
  domain: new GitHubDomainAdapter({ githubToken: process.env.GITHUB_TOKEN }),
  llm: { apiKey: process.env.OPENAI_API_KEY },
});

// Run a full observe → reason → predict cycle
const predictions = await world.runCycle();

// Or predict a specific target
const prediction = await world.predict({
  target: 'facebook/react',
  metric: 'stars',
  timeframe: '30d',
});
```

### Build Your Own Domain

```ts
import { WorldModel } from 'worldmind';

// Any domain — just define entities, metrics, and knowledge
const cryptoWorld = new WorldModel({
  domain: {
    name: 'crypto',
    description: 'Cryptocurrency market dynamics',
    entityTypes: ['token', 'protocol', 'exchange'],
    metrics: ['price', 'volume', 'tvl'],
    temporalRules: [
      'Bull cycles last ~18 months on average',
      'Halving events precede rallies by 3-6 months',
    ],
    initialKnowledge: [
      { topic: 'cycles', content: 'Bear markets bottom when leverage is fully flushed', source: 'analysis', relevance: 0.9 },
    ],
  },
});
```

### CLI

```bash
git clone https://github.com/Myles-Liu/worldmind.git
cd worldmind && npm install
cp .env.example .env  # Add your API keys

# Full pipeline: discover → analyze → predict → challenge → revise
npx tsx scripts/run-discovery-analysis.ts --top 10

# Predict a specific repo
npx tsx scripts/predict-repo.ts karpathy/autoresearch

# Crypto domain demo (no API key needed)
npx tsx scripts/predict-crypto.ts --tokens=bitcoin,ethereum,solana

# Backtest against historical data
npx tsx scripts/backtest.ts --predict-only --fast
```

## 📊 Demo Output (Real Run — March 9, 2026)

```
╔══════════════════════════════════════════════════════════════╗
║  WorldMind Discovery + Analysis Pipeline                    ║
║  "Which new repo will blow up? Let 5 Agents decide."       ║
╚══════════════════════════════════════════════════════════════╝

═══ Phase 1: Discovery ═══
  📡 New repos: 50 | HN mentions: 32 | Trending: 30
  📊 110 unique repos → 2 multi-signal → Top 5 selected

═══ Phase 2: Agent Analysis ═══
  🔍 Trend Agent (45s)     → 4 trending: autoresearch (98%), CLI-Anything, Shadowbroker, OBLITERATUS
  🌐 Network + ⚡ Tech (38s) → Mapped clusters, found rising tech
  🎯 Predict Agent (40s)   → 5 predictions (72% to 45% confidence)
  ⚔️  Challenge Agent (63s) → 4 weakened, 1 rejected
  🔄 Round 2 Revision (46s) → All predictions revised downward after debate

═══ Final Rankings ═══
  🥇 karpathy/autoresearch         58%  explosive  50000→25000★ in 30d
  🥈 elder-plinius/OBLITERATUS     51%  fast       4800→3200★ in 30d
  🥉 HKUDS/CLI-Anything            48%  moderate   2800→1400★ in 30d

  ⏱️ Total: 438s | 110 repos discovered → 5 analyzed → 5 ranked
```

**What happened**: The Predict Agent initially predicted 50,000 stars for `karpathy/autoresearch`. The Challenge Agent attacked this as overconfident — Karpathy is famous but 50K in 30 days would be unprecedented. Round 2: Predict accepted the challenge and revised to 25,000. That's the system working as designed.

## 📁 Project Structure

```
worldmind/
├── src/
│   ├── api/              # Public API entry point
│   │   └── index.ts      # WorldModel, types, re-exports
│   ├── domains/          # Domain adapters (pluggable)
│   │   ├── types.ts      # DomainAdapter interface, WorldModel class
│   │   └── github/       # Built-in GitHub domain
│   │       └── adapter.ts
│   ├── agents/           # Agent implementations
│   │   ├── base-agent.ts # Generic base (domain-agnostic)
│   │   ├── trend.ts      # Spot emerging patterns
│   │   ├── network.ts    # Map entity relationships
│   │   ├── tech.ts       # Track technology lifecycles
│   │   ├── predict.ts    # Synthesize into predictions
│   │   └── challenge.ts  # Stress-test every prediction
│   ├── llm/              # LLM orchestration
│   │   ├── context-engine.ts   # 5-layer prompt builder
│   │   └── client.ts           # OpenAI-compatible client
│   ├── context/          # Inter-agent communication
│   │   └── shared-bus.ts       # Summary-based messaging
│   ├── memory/           # Storage & retrieval
│   │   ├── semantic-memory.ts  # TF-IDF retrieval, no vector DB
│   │   ├── knowledge-base.ts   # Domain knowledge injection
│   │   └── prediction-store.ts
│   └── collectors/       # Data sources (GitHub-specific)
│       ├── discovery.ts  # Multi-source aggregator
│       ├── hn.ts         # HackerNews scanner
│       └── star-history.ts
├── scripts/
│   ├── run-discovery-analysis.ts  # Full pipeline (GitHub)
│   ├── predict-repo.ts            # Predict a single repo
│   ├── backtest.ts                # Validate against history
│   └── verify-predictions.ts      # Check past predictions
└── docs/
    └── anthropic-context-engineering-notes.md
```

## 🛠️ Tech Stack

- **Language**: TypeScript (Node.js)
- **LLM**: OpenAI-compatible API (default: OpenAI)
- **Data**: GitHub API, HackerNews API (free, no paid APIs)
- **Storage**: JSON files (no external DB required)
- **No vector DBs** — pure TF-IDF semantic memory

## 📈 Prediction Accuracy (Backtested)

WorldMind predictions are validated against **real historical data** — no waiting 30 days:

| Repo | Predicted (30d) | Actual | Error | Grade |
|------|----------------|--------|-------|-------|
| electric-sql/pglite | 7,000 | 7,127 | **-2%** | 🅰️ |
| cohere-ai/cohere-toolkit | 2,700 | 2,144 | +26% | 🅱️ |
| jina-ai/reader | 4,200 | 5,913 | -29% | 🅱️ |
| stanford-oval/storm | 11,500 | 16,932 | -32% | 🅲️ |
| karpathy/LLM101n | 22,000 | 32,257 | -32% | 🅲️ |

**How backtesting works**: Take a repo that "blew up" 3 months ago. Pretend to be at Day 3 of its growth. Feed only those 3 days to the agents. Compare prediction against what actually happened. Instant validation.

**Calibration feedback loop**: Each backtest run updates a calibration entry in the knowledge base. The Predict Agent sees its historical accuracy and adjusts — a self-improving system.

## 🤝 Contributing

This is a research prototype. PRs welcome, especially around:

- Better prediction calibration
- Additional data sources (Reddit, Twitter/X)
- Visualization of the world model

## 📄 License

MIT

---

*Built with the belief that AI systems should be verifiable, not just impressive.*

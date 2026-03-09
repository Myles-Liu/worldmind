# 🌍 WorldMind

**A multi-agent world model engine — observe, reason, predict, simulate.**

> *"Give AI agents the fourth dimension: time."*

WorldMind is a domain-agnostic engine that spawns specialized AI agents to continuously perceive, model, and reason about any domain. It ships with three built-in domains — **GitHub** (trend prediction), **Crypto** (market analysis), and **Social** (OASIS-powered social simulation) — and you can build your own in ~50 lines.

## ✨ What It Does

| Mode | Description |
|------|-------------|
| **🔮 Predict** | 5 agents discover, analyze, debate, and rank emerging trends (GitHub, Crypto, or custom) |
| **🌐 Simulate** | Spin up a living social world — 10+ AI agents posting, replying, following, arguing — and join as a player |
| **🧪 Backtest** | Validate predictions against real historical data. Self-calibrating feedback loop. |

### The Prediction Pipeline

```
Discovery → Trend Agent → Network + Tech (parallel) → Predict → Challenge → Revision
```

Each prediction is **attacked** by the Challenge Agent before it ships. Overconfident claims get revised downward. Weak evidence gets called out. The system argues with itself so you don't have to.

### The Social Simulation

WorldMind can spawn an entire social platform (powered by [OASIS](https://github.com/camel-ai/oasis)) where AI agents have persistent memory, form relationships, and react to injected events — in any language, any culture, any topic.

You can:
- **Play** as a participant (post, comment, like, follow)
- **Observe** as a god-mode admin (inject news, kill agents, interview them)
- **Experiment** with different world configurations

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      WorldMind Engine                           │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Context Engine (5-layer)   │  SharedContextBus           │  │
│  │  Semantic Memory (TF-IDF)   │  Knowledge Base             │  │
│  │  Agent Memory (episodic/social/semantic)                   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Agent Pipeline (5 specialized agents)                    │  │
│  │  Observe → Analyze → Predict → Challenge → Revise         │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Interactive World Engine (OASIS bridge)                   │  │
│  │  Player mode │ Admin mode │ Persistent agent memory       │  │
│  └───────────────────────────────────────────────────────────┘  │
└────────────────────────────┬─────────────────────────────────────┘
                             │
              ┌──────────────┼──────────────┬──────────────┐
              ▼              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
        │  GitHub  │  │  Crypto  │  │  Social  │  │  Custom  │
        │ Adapter  │  │ Adapter  │  │ Adapter  │  │ Adapter  │
        └──────────┘  └──────────┘  └──────────┘  └──────────┘
```

### Context Engine (5 Layers)

Inspired by [Anthropic's context engineering principles](docs/anthropic-context-engineering-notes.md):

| Layer | Purpose | Compression |
|-------|---------|-------------|
| **Identity** | Agent soul + role | Never compressed |
| **World State** | Current domain state | Dynamic budget |
| **Working Memory** | Task-specific context | Dynamic budget |
| **Long-term Memory** | Lessons from past cycles | Importance-weighted decay |
| **Knowledge** | Domain facts + calibration | Injected per domain |

### Agent Memory System (v2)

Each agent in the social simulation maintains three types of persistent memory:

- **Episodic** — what happened (posts seen, interactions had)
- **Social** — relationships (sentiment toward other agents, interaction history)
- **Semantic** — learned facts and opinions formed during simulation

Memory persists across rounds and is injected into agent prompts, enabling genuine personality evolution and relationship dynamics.

## 🚀 Quick Start

```bash
git clone https://github.com/Myles-Liu/worldmind.git
cd worldmind && npm install
cp .env.example .env  # Add your API keys
```

### Predict: GitHub Trend Discovery

```bash
# Full pipeline: discover → analyze → predict → challenge → revise
npx tsx scripts/run-discovery-analysis.ts --top 10

# Predict a specific repo
npx tsx scripts/predict-repo.ts karpathy/autoresearch
```

### Predict: Crypto Market

```bash
# No API key needed — uses CoinGecko free API
npx tsx scripts/predict-crypto.ts --tokens=bitcoin,ethereum,solana
```

### Simulate: Interactive Social World

```bash
# Launch a social simulation with a world config
npx tsx scripts/play.ts --world worlds/cn-tech.json    # 中文科技圈
npx tsx scripts/play.ts --world worlds/cn-finance.json  # 中文投资社区
npx tsx scripts/play.ts --world worlds/en-tech.json     # English tech Twitter
```

### Backtest: Validate Predictions

```bash
npx tsx scripts/backtest.ts --predict-only --fast
```

### As a Library

```ts
import { WorldModel, GitHubDomainAdapter } from 'worldmind';

const world = new WorldModel({
  domain: new GitHubDomainAdapter({ githubToken: process.env.GITHUB_TOKEN }),
  llm: { apiKey: process.env.OPENAI_API_KEY },
});

const predictions = await world.runCycle();
```

### Build Your Own Domain

```ts
import { WorldModel } from 'worldmind';

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

## 🌐 World Configurations

Worlds are pure JSON — no code required. Define a community and watch it come alive:

```json
{
  "name": "中文科技圈",
  "language": "中文",
  "culture": "中国科技圈文化。大家直来直去，喜欢用梗和网络用语。",
  "agentCount": 10,
  "archetypes": [
    { "role": "engineer", "personality": "务实的技术人，关注 AI 和 Web 开发。" },
    { "role": "vc", "personality": "追踪新兴项目，关注增长和市场规模。" },
    { "role": "skeptic", "personality": "唱反调，挑战炒作。以犀利点评出名。" }
  ]
}
```

Ships with 3 worlds: `cn-tech` (中文科技), `cn-finance` (中文投资), `en-tech` (English tech).

## 📊 Demo Output (Real Runs)

### GitHub Discovery Pipeline

```
╔══════════════════════════════════════════════════════════════╗
║  WorldMind Discovery + Analysis Pipeline                    ║
║  "Which new repo will blow up? Let 5 Agents decide."       ║
╚══════════════════════════════════════════════════════════════╝

═══ Phase 1: Discovery ═══
  📡 New repos: 50 | HN mentions: 32 | Trending: 30
  📊 110 unique repos → 2 multi-signal → Top 5 selected

═══ Phase 2: Agent Analysis ═══
  🔍 Trend Agent (45s)     → 4 trending signals
  🌐 Network + ⚡ Tech (38s) → Mapped clusters + rising tech
  🎯 Predict Agent (40s)   → 5 predictions (72%-45% confidence)
  ⚔️  Challenge Agent (63s) → 4 weakened, 1 rejected
  🔄 Round 2 Revision (46s) → All predictions revised after debate

═══ Final Rankings ═══
  🥇 karpathy/autoresearch         58%  explosive  25000★/30d
  🥈 elder-plinius/OBLITERATUS     51%  fast       3200★/30d
  🥉 HKUDS/CLI-Anything            48%  moderate   1400★/30d

  ⏱️ Total: 438s | 110 repos → 5 analyzed → 5 ranked
```

### Crypto Domain

```
═══ Crypto Analysis ═══
  📈 3 tokens analyzed (CoinGecko API)
  🎯 4 predictions generated
  ⚔️  Challenge: revised all predictions downward
  🔄 Calibration data → knowledge base
```

### Backtest Results (Historical Validation)

| Repo | Predicted (30d) | Actual | Error | Grade |
|------|----------------|--------|-------|-------|
| electric-sql/pglite | 7,000 | 7,127 | **-2%** | 🅰️ |
| cohere-ai/cohere-toolkit | 2,700 | 2,144 | +26% | 🅱️ |
| jina-ai/reader | 4,200 | 5,913 | -29% | 🅱️ |
| stanford-oval/storm | 11,500 | 16,932 | -32% | 🅲️ |
| karpathy/LLM101n | 22,000 | 32,257 | -32% | 🅲️ |

Self-calibrating: each backtest updates the knowledge base → next run is more accurate.

## 📁 Project Structure

```
worldmind/
├── src/
│   ├── api/                # Public API (WorldModel, exports)
│   ├── domains/            # Domain adapters (pluggable)
│   │   ├── types.ts        # DomainAdapter interface
│   │   ├── github/         # GitHub trend prediction
│   │   ├── crypto/         # Cryptocurrency analysis
│   │   └── social/         # OASIS social simulation
│   ├── agents/             # 5 specialized agents
│   │   ├── base-agent.ts   # Domain-agnostic base
│   │   ├── trend.ts        # Spot emerging patterns
│   │   ├── network.ts      # Map relationships
│   │   ├── tech.ts         # Track technology lifecycles
│   │   ├── predict.ts      # Synthesize predictions
│   │   └── challenge.ts    # Stress-test every prediction
│   ├── player/             # Interactive world engine
│   │   ├── engine.ts       # OASIS bridge + lifecycle
│   │   ├── memory.ts       # Agent memory (episodic/social/semantic)
│   │   ├── world-config.ts # World settings loader
│   │   └── types.ts        # Player/Admin action types
│   ├── llm/                # LLM orchestration
│   │   ├── context-engine.ts    # 5-layer prompt builder
│   │   └── client.ts            # OpenAI-compatible client
│   ├── context/            # Inter-agent communication
│   │   └── shared-bus.ts        # Summary-based messaging
│   ├── memory/             # Storage & retrieval
│   │   ├── semantic-memory.ts   # TF-IDF, no vector DB
│   │   ├── agent-memory.ts      # Per-agent persistent memory
│   │   ├── knowledge-base.ts    # Domain knowledge injection
│   │   └── prediction-store.ts
│   └── collectors/         # Data sources
│       ├── discovery.ts    # Multi-source aggregator
│       ├── github.ts       # GitHub API
│       ├── hn.ts           # HackerNews scanner
│       ├── new-repos.ts    # New repo scanner
│       └── star-history.ts # Star time-series
├── worlds/                 # World configuration files (JSON)
│   ├── cn-tech.json        # 中文科技圈
│   ├── cn-finance.json     # 中文投资社区
│   └── en-tech.json        # English tech Twitter
├── scripts/
│   ├── run-discovery-analysis.ts  # Full GitHub pipeline
│   ├── predict-repo.ts            # Single repo prediction
│   ├── predict-crypto.ts          # Crypto domain demo
│   ├── play.ts                    # Interactive world launcher
│   ├── backtest.ts                # Historical validation
│   └── verify-predictions.ts      # Check past predictions
├── data/                          # Runtime data (gitignored)
└── docs/
    └── anthropic-context-engineering-notes.md
```

## 🛠️ Tech Stack

- **Language**: TypeScript (Node.js)
- **LLM**: Any OpenAI-compatible API
- **Social Simulation**: [OASIS](https://github.com/camel-ai/oasis) (Python subprocess)
- **Data**: GitHub API, HackerNews API, CoinGecko API (all free)
- **Storage**: JSON files — no external DB required
- **No vector DBs** — pure TF-IDF semantic memory

## 🧠 Design Philosophy

1. **Domain-agnostic core** — The engine doesn't know about GitHub or crypto. Domains plug in as adapters.
2. **Adversarial reasoning** — Every prediction is attacked before it ships. The Challenge Agent is a professional skeptic.
3. **Self-calibrating** — Backtest results feed back into the knowledge base. The system learns from its mistakes.
4. **Context over tokens** — Signal-to-noise ratio matters more than prompt length. 5-layer context engineering keeps agents focused.
5. **No black boxes** — Every prediction includes evidence chains, challenge reports, and revision history.
6. **Time as first-class** — Every fact, memory, and relationship has temporal metadata. The world model lives on a timeline.

## 🤝 Contributing

Research prototype. PRs welcome — especially:

- New domain adapters
- Better prediction calibration
- Additional data sources (Reddit, Twitter/X, ArXiv)
- World configurations for new communities
- Visualization of agent reasoning

## 📄 License

MIT

---

*Built with the belief that AI systems should model the world, not just respond to prompts.*

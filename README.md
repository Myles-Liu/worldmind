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

```
┌─────────────────────────────────────────────────────────────────┐
│                     SharedContextBus                            │
│   (summary-based inter-agent communication)                    │
└──────────────────────────┬──────────────────────────────────────┘
                          │
    ┌─────────────────────┼─────────────────────┐
    │                     │                     │
    ▼                     ▼                     ▼
┌─────────┐         ┌─────────┐           ┌─────────┐
│ Trend   │────────▶│ Network │──────────▶│  Tech   │
│ Agent   │         │ Agent   │           │  Agent  │
└────┬────┘         └────┬────┘           └────┬────┘
     │                   │                     │
     └───────────────────┴─────────────────────┘
                         │
                         ▼
                   ┌───────────┐
                   │  Predict  │
                   │   Agent   │
                   └─────┬─────┘
                         │
                         ▼
                   ┌───────────┐
                   │ Challenge │ ◀── Stress-test
                   │   Agent   │     every prediction
                   └─────┬─────┘
                         │
                         ▼
                   ┌───────────┐
                   │   Round   │ ◀── Revise based on
                   │    2      │     counter-evidence
                   └───────────┘
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

```bash
# Clone
git clone https://github.com/Myles-Liu/worldmind.git
cd worldmind

# Install
npm install

# Configure (or use defaults — will use OpenAI API)
cp .env.example .env
# Edit .env with your API keys

# Run discovery + prediction (analyzes top 10 new repos)
npx tsx scripts/run-discovery-analysis.ts --top 10

# Or run backtest to verify prediction accuracy
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
│   ├── agents/           # 5 specialized agents
│   │   ├── trend.ts      # Spot emerging patterns
│   │   ├── network.ts    # Map relationships
│   │   ├── tech.ts       # Track tech lifecycles
│   │   ├── predict.ts    # Make predictions
│   │   └── challenge.ts  # Stress-test predictions
│   ├── collectors/       # Data sources
│   │   ├── discovery.ts  # Find new repos
│   │   ├── hn.ts        # HackerNews scanner
│   │   └── star-history.ts
│   ├── memory/          # Context & storage
│   │   ├── semantic-memory.ts   # TF-IDF retrieval
│   │   ├── entity-store.ts     # Entity profiles
│   │   ├── knowledge-base.ts   # Domain knowledge
│   │   └── prediction-store.ts
│   ├── llm/             # LLM orchestration
│   │   ├── context-engine.ts   # 5-layer prompt builder
│   │   └── client.ts           # OpenAI-compatible client
│   ├── context/         # Inter-agent communication
│   │   └── shared-bus.ts       # Summary-based messaging
│   └── world-model/     # Belief state
│       └── belief-state.ts
├── scripts/
│   ├── run-discovery-analysis.ts  # Full pipeline
│   ├── backtest.ts                # Verify predictions
│   └── collect-benchmarks.ts      # Build decay models
├── docs/
│   └── anthropic-context-engineering-notes.md
└── README.md
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

# 🌍 WorldMind

**A multi-agent world model engine that watches, learns, and predicts.**

WorldMind continuously observes a domain, builds a structured internal model, and produces verifiable predictions — then checks if it was right.

## How It Works

```
Perceive → Remember → Reason → Predict → Verify → Learn
```

Five specialized AI agents collaborate to understand the world:

| Agent | Role |
|-------|------|
| **Trend** | Spots emerging patterns and anomalies |
| **Network** | Maps relationships between entities |
| **Tech** | Tracks technology adoption lifecycles |
| **Predict** | Synthesizes signals into predictions |
| **Challenge** | Stress-tests every prediction |

## First Target: GitHub Open Source

The initial domain is the GitHub ecosystem — repos, developers, and technology trends. WorldMind watches what's happening and makes concrete, time-bound predictions like:

> "This repo will reach 5,000 stars within 14 days" (confidence: 0.65)

Then it checks. And learns.

## Quick Start

```bash
# Install dependencies
npm install

# Set up environment (optional — has defaults)
export WORLDMIND_LLM_BASE_URL=https://api.openai.com/v1
export WORLDMIND_LLM_API_KEY=sk-your-api-key-here
export GITHUB_TOKEN=your_github_token

# Run a single cycle
npx tsx src/index.ts

# Validate past predictions
npx tsx scripts/validate.ts
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full technical design.

## Project Status

**Phase 1** — Foundation (in progress)
- [x] Project skeleton and type system
- [ ] GitHub data collector
- [ ] Entity store
- [ ] Trend Agent (MVP)
- [ ] CLI output

## License

MIT

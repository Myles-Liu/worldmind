#!/usr/bin/env tsx
/**
 * collect-benchmarks.ts
 *
 * Collects star histories for a diverse set of previously-trending repos,
 * fits decay models, and generates a knowledge-base entry with empirical
 * parameters for each category.
 *
 * Usage:
 *   npx tsx scripts/collect-benchmarks.ts
 *   npx tsx scripts/collect-benchmarks.ts --resume   # skip repos already collected
 *   npx tsx scripts/collect-benchmarks.ts --analyze   # skip collection, re-analyze
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StarHistoryCollector, RateLimitError, type RateLimitInfo } from '../src/collectors/star-history.js';
import { analyzeDecay, type DecayAnalysis } from '../src/analysis/decay-model.js';
import type { StarHistory } from '../src/collectors/star-history.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════
// Benchmark repos
// ═══════════════════════════════════════════════════════════════

interface BenchmarkRepo {
  repo: string;
  category: 'influencer' | 'tool' | 'content' | 'platform';
  note: string;
}

const BENCHMARK_REPOS: BenchmarkRepo[] = [
  // ═══ Influencer repos (big-name authors) ═══
  { repo: 'karpathy/nanoGPT', category: 'influencer', note: 'Karpathy, minimal GPT' },
  { repo: 'karpathy/llm.c', category: 'influencer', note: 'Karpathy, LLM in C' },
  { repo: 'karpathy/minbpe', category: 'influencer', note: 'Karpathy, minimal BPE' },
  { repo: 'antirez/smallchat', category: 'influencer', note: 'Redis creator, minimal chat' },
  { repo: 'ThePrimeagen/harpoon', category: 'influencer', note: 'ThePrimeagen, neovim nav' },
  { repo: 'fireship-io/flamethrower', category: 'influencer', note: 'Fireship, router' },
  { repo: 'geohot/tinygrad', category: 'influencer', note: 'George Hotz, tiny ML framework' },
  { repo: 'tinygrad/tinygrad', category: 'influencer', note: 'tinygrad org (same project, later)' },

  // ═══ Tool repos (genuine daily-driver utility) ═══
  { repo: 'google/zx', category: 'tool', note: 'Better shell scripting in JS' },
  { repo: 'astral-sh/ruff', category: 'tool', note: 'Fast Python linter in Rust' },
  { repo: 'astral-sh/uv', category: 'tool', note: 'Fast Python package manager' },
  { repo: 'BurntSushi/ripgrep', category: 'tool', note: 'Fast grep in Rust' },
  { repo: 'sharkdp/bat', category: 'tool', note: 'Cat clone with syntax highlighting' },
  { repo: 'junegunn/fzf', category: 'tool', note: 'Fuzzy finder' },
  { repo: 'charmbracelet/bubbletea', category: 'tool', note: 'Go TUI framework' },
  { repo: 'biomejs/biome', category: 'tool', note: 'JS/TS toolchain in Rust' },
  { repo: 'eza-community/eza', category: 'tool', note: 'Modern ls replacement' },
  { repo: 'casey/just', category: 'tool', note: 'Command runner' },

  // ═══ AI/ML hype repos (explosive growth) ═══
  { repo: 'Significant-Gravitas/AutoGPT', category: 'content', note: 'Auto-GPT, peak AI hype' },
  { repo: 'AUTOMATIC1111/stable-diffusion-webui', category: 'tool', note: 'SD WebUI' },
  { repo: 'ggerganov/llama.cpp', category: 'tool', note: 'Local LLM inference in C++' },
  { repo: 'openai/whisper', category: 'influencer', note: 'OpenAI speech recognition' },
  { repo: 'facebookresearch/llama', category: 'influencer', note: 'Meta LLaMA' },
  { repo: 'deepseek-ai/DeepSeek-Coder', category: 'influencer', note: 'DeepSeek coding model' },
  { repo: 'binary-husky/gpt_academic', category: 'tool', note: 'GPT for academic writing' },
  { repo: 'lm-sys/FastChat', category: 'platform', note: 'LLM serving platform' },

  // ═══ Content/viral repos ═══
  { repo: 'kelseyhightower/nocode', category: 'content', note: 'Joke: no code' },
  { repo: 'EnterpriseQualityCoding/FizzBuzzEnterpriseEdition', category: 'content', note: 'Satire' },
  { repo: 'Asabeneh/30-Days-Of-JavaScript', category: 'content', note: 'Tutorial series' },
  { repo: 'sindresorhus/awesome', category: 'content', note: 'Awesome lists meta-list' },
  { repo: 'jwasham/coding-interview-university', category: 'content', note: 'Interview prep guide' },
  { repo: 'practical-tutorials/project-based-learning', category: 'content', note: 'Learning by building' },
  { repo: 'codecrafters-io/build-your-own-x', category: 'content', note: 'Build your own X' },
  { repo: 'EbookFoundation/free-programming-books', category: 'content', note: 'Free books list' },

  // ═══ Platform/ecosystem repos ═══
  { repo: 'langchain-ai/langchain', category: 'platform', note: 'LLM application framework' },
  { repo: 'ollama/ollama', category: 'platform', note: 'Local LLM runner' },
  { repo: 'vercel/next.js', category: 'platform', note: 'React framework' },
  { repo: 'denoland/deno', category: 'platform', note: 'JS/TS runtime' },
  { repo: 'supabase/supabase', category: 'platform', note: 'Open source Firebase' },
  { repo: 'pocketbase/pocketbase', category: 'platform', note: 'Go backend in one file' },
  { repo: 'shadcn-ui/ui', category: 'platform', note: 'UI component library' },
  { repo: 'hpcaitech/ColossalAI', category: 'platform', note: 'Distributed AI training' },
  { repo: 'open-webui/open-webui', category: 'platform', note: 'Web UI for local LLMs' },
  { repo: 'microsoft/autogen', category: 'platform', note: 'Multi-agent framework' },
];

// ═══════════════════════════════════════════════════════════════
// Paths
// ═══════════════════════════════════════════════════════════════

const DATA_DIR = 'data/star-histories';
const ANALYSIS_DIR = 'data/decay-analysis';
const KNOWLEDGE_DIR = 'data/knowledge';

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const resumeMode = args.includes('--resume');
  const analyzeOnly = args.includes('--analyze');

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  WorldMind Star Decay Benchmark Collection      ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`Mode: ${analyzeOnly ? 'analyze-only' : resumeMode ? 'resume' : 'full'}`);

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(ANALYSIS_DIR, { recursive: true });
  await fs.mkdir(KNOWLEDGE_DIR, { recursive: true });

  const collector = new StarHistoryCollector({ dataDir: DATA_DIR });
  const histories: StarHistory[] = [];
  const analyses: DecayAnalysis[] = [];

  // ─── Phase 1: Collect star histories ────────────────────────

  if (!analyzeOnly) {
    console.log('\n━━━ Phase 1: Collecting Star Histories ━━━\n');

    for (const bench of BENCHMARK_REPOS) {
      // Check cache
      if (resumeMode) {
        const cached = await collector.loadCached(bench.repo);
        if (cached && cached.dataPoints.length > 3) {
          console.log(`✅ ${bench.repo} — cached (${cached.dataPoints.length} data points)`);
          histories.push(cached);
          continue;
        }
      }

      // Check rate limit before each repo
      const rl = collector.getRateLimit();
      if (rl.remaining < 3) {
        const waitMs = Math.max(0, rl.reset * 1000 - Date.now()) + 2000;
        if (waitMs > 600_000) { // > 10 minutes
          console.log(`\n⏳ Rate limit: ${rl.remaining} remaining, resets in ${Math.ceil(waitMs / 60000)}m — too long, saving & exiting.`);
          console.log(`   Run again with --resume to continue.\n`);
          break;
        }
        console.log(`\n⏳ Rate limit low (${rl.remaining}). Waiting ${Math.ceil(waitMs / 1000)}s for reset...`);
        await sleep(waitMs);
      }

      try {
        const history = await collector.collect(bench.repo);
        histories.push(history);
        console.log(`  ✅ ${bench.repo}: ${history.dataPoints.length} data points, peak ${history.peakDailyStars}/day on ${history.peakDate}`);
      } catch (e) {
        if (e instanceof RateLimitError) {
          console.log(`\n🛑 Rate limited! Saving progress.`);
          console.log(`   Resets at: ${new Date(e.resetAt * 1000).toLocaleString()}`);

          // Wait for reset if < 10 min, then retry this repo
          const waitMs = Math.max(0, e.resetAt * 1000 - Date.now()) + 2000;
          if (waitMs <= 600_000) {
            console.log(`   Waiting ${Math.ceil(waitMs / 1000)}s for reset...`);
            await sleep(waitMs);
            // Retry this repo
            try {
              const history = await collector.collect(bench.repo);
              histories.push(history);
              console.log(`  ✅ ${bench.repo} (retry): ${history.dataPoints.length} data points`);
            } catch {
              console.log(`  ❌ ${bench.repo}: retry also failed`);
            }
          } else {
            console.log(`   Too long to wait. Run again with --resume.\n`);
            break;
          }
        } else {
          console.log(`  ❌ ${bench.repo}: ${(e as Error).message}`);
        }
      }
    }

    // Load cached for any repos we didn't collect
    for (const bench of BENCHMARK_REPOS) {
      if (!histories.find(h => h.repo === bench.repo)) {
        const cached = await collector.loadCached(bench.repo);
        if (cached && cached.dataPoints.length > 0) {
          histories.push(cached);
          console.log(`  📂 ${bench.repo}: loaded from cache (${cached.dataPoints.length} data points)`);
        }
      }
    }

    console.log(`\nCollected ${histories.length}/${BENCHMARK_REPOS.length} repos.`);
  } else {
    // Load all cached histories
    console.log('\n━━━ Loading cached star histories ━━━\n');
    for (const bench of BENCHMARK_REPOS) {
      const cached = await collector.loadCached(bench.repo);
      if (cached) {
        histories.push(cached);
        console.log(`  📂 ${bench.repo}: ${cached.dataPoints.length} data points`);
      } else {
        console.log(`  ⚠️ ${bench.repo}: no cached data`);
      }
    }
  }

  // ─── Phase 2: Fit decay models ─────────────────────────────

  if (histories.length === 0) {
    console.log('\n⚠️ No data to analyze. Exiting.');
    return;
  }

  console.log('\n━━━ Phase 2: Fitting Decay Models ━━━\n');

  for (const history of histories) {
    const bench = BENCHMARK_REPOS.find(b => b.repo === history.repo);
    const category = bench?.category ?? 'generic';

    try {
      const analysis = analyzeDecay(history, category);
      analyses.push(analysis);

      console.log(`\n  📈 ${analysis.repo} (${category})`);
      console.log(`     Peak: ${analysis.peakDailyStars}/day on day ${analysis.daysToPeak}`);
      console.log(`     Post-peak data points: ${analysis.postPeakDataPoints}`);
      if (analysis.bestModel.r_squared > 0) {
        console.log(`     Best model: ${analysis.bestModel.type} (R²=${analysis.bestModel.r_squared.toFixed(4)})`);
        console.log(`     Half-life: ${analysis.halfLife} days`);
        console.log(`     Day 30 prediction: ${analysis.day30Prediction}/day`);
      } else {
        console.log(`     ⚠️ Insufficient data for model fitting`);
      }

      // Save individual analysis
      const safeRepo = history.repo.replace('/', '__');
      await fs.writeFile(
        path.join(ANALYSIS_DIR, `${safeRepo}.json`),
        JSON.stringify(analysis, null, 2),
      );
    } catch (e) {
      console.log(`  ❌ Analysis failed for ${history.repo}: ${(e as Error).message}`);
    }
  }

  // ─── Phase 3: Generate summary & knowledge base entry ──────

  console.log('\n━━━ Phase 3: Generating Knowledge Base Entry ━━━\n');

  const knowledgeEntry = generateKnowledgeEntry(analyses);

  await fs.writeFile(
    path.join(KNOWLEDGE_DIR, 'star-decay-models.json'),
    JSON.stringify(knowledgeEntry, null, 2),
  );

  console.log('✅ Knowledge base entry written to data/knowledge/star-decay-models.json');

  // ─── Phase 4: Print summary report ─────────────────────────

  printSummaryReport(analyses);
}

// ═══════════════════════════════════════════════════════════════
// Knowledge base entry generation
// ═══════════════════════════════════════════════════════════════

interface CategorySummary {
  bestModel: string;
  typicalHalfLife: string;
  averageR2: number;
  params: Record<string, number>;
  examples: Array<{
    repo: string;
    bestModel: string;
    r2: number;
    halfLife: number;
    peakDailyStars: number;
  }>;
}

function generateKnowledgeEntry(analyses: DecayAnalysis[]) {
  const categories: Record<string, CategorySummary> = {};

  // Group by category
  const grouped = new Map<string, DecayAnalysis[]>();
  for (const a of analyses) {
    const list = grouped.get(a.category) ?? [];
    list.push(a);
    grouped.set(a.category, list);
  }

  // Count which model type wins most often
  const modelWins: Record<string, number> = {};

  for (const [cat, catAnalyses] of grouped) {
    const validAnalyses = catAnalyses.filter(a => a.bestModel.r_squared > 0);

    if (validAnalyses.length === 0) {
      categories[cat] = {
        bestModel: 'unknown',
        typicalHalfLife: 'insufficient data',
        averageR2: 0,
        params: {},
        examples: [],
      };
      continue;
    }

    // Find most common best model type
    const typeCounts: Record<string, number> = {};
    for (const a of validAnalyses) {
      typeCounts[a.bestModel.type] = (typeCounts[a.bestModel.type] ?? 0) + 1;
      modelWins[a.bestModel.type] = (modelWins[a.bestModel.type] ?? 0) + 1;
    }
    const bestType = Object.entries(typeCounts).sort(([, a], [, b]) => b - a)[0]?.[0] ?? 'unknown';

    // Average half-life
    const halfLives = validAnalyses.map(a => a.halfLife).filter(h => isFinite(h));
    const avgHalfLife = halfLives.length > 0
      ? Math.round(halfLives.reduce((s, h) => s + h, 0) / halfLives.length)
      : NaN;

    // Average R² for the best model type
    const bestTypeAnalyses = validAnalyses.filter(a => a.bestModel.type === bestType);
    const avgR2 = bestTypeAnalyses.length > 0
      ? bestTypeAnalyses.reduce((s, a) => s + a.bestModel.r_squared, 0) / bestTypeAnalyses.length
      : 0;

    // Average params for best model type
    const avgParams: Record<string, number> = {};
    if (bestTypeAnalyses.length > 0) {
      const allParams = bestTypeAnalyses.map(a => a.bestModel.params);
      const keys = Object.keys(allParams[0] ?? {});
      for (const k of keys) {
        avgParams[k] = allParams.reduce((s, p) => s + (p[k] ?? 0), 0) / allParams.length;
      }
    }

    categories[cat] = {
      bestModel: bestType,
      typicalHalfLife: isFinite(avgHalfLife) ? `${avgHalfLife} days` : 'insufficient data',
      averageR2: Math.round(avgR2 * 10000) / 10000,
      params: avgParams,
      examples: validAnalyses.map(a => ({
        repo: a.repo,
        bestModel: a.bestModel.type,
        r2: Math.round(a.bestModel.r_squared * 10000) / 10000,
        halfLife: a.halfLife,
        peakDailyStars: a.peakDailyStars,
      })),
    };
  }

  // General findings
  const totalValid = analyses.filter(a => a.bestModel.r_squared > 0).length;
  const findings: string[] = [];

  if (totalValid > 0) {
    // Which model wins overall?
    const sorted = Object.entries(modelWins).sort(([, a], [, b]) => b - a);
    if (sorted.length > 0) {
      const [topModel, topCount] = sorted[0]!;
      const pct = Math.round((topCount / totalValid) * 100);
      findings.push(
        `${topModel} decay fits best for ${pct}% of repos (${topCount}/${totalValid}).`,
      );
    }

    // Compare half-lives across categories
    for (const [cat, summary] of Object.entries(categories)) {
      if (summary.typicalHalfLife !== 'insufficient data') {
        findings.push(
          `${cat} repos: typical half-life = ${summary.typicalHalfLife}, best fit = ${summary.bestModel} (avg R² = ${summary.averageR2.toFixed(4)}).`,
        );
      }
    }

    // All model R² comparison
    const allR2ByType: Record<string, number[]> = {};
    for (const a of analyses) {
      for (const m of a.models) {
        const list = allR2ByType[m.type] ?? [];
        list.push(m.r_squared);
        allR2ByType[m.type] = list;
      }
    }
    for (const [mtype, r2s] of Object.entries(allR2ByType)) {
      const avg = r2s.reduce((s, v) => s + v, 0) / r2s.length;
      findings.push(`Average R² for ${mtype}: ${avg.toFixed(4)} (across ${r2s.length} fits).`);
    }
  }

  return {
    topic: 'github_star_decay_models',
    content: [
      'Empirical analysis of GitHub star growth/decay patterns based on historical stargazer data.',
      'Fitted four candidate models (exponential, power law, stretched exponential, log-normal) to',
      'post-peak daily star counts for repos across categories: influencer, tool, content, platform.',
      'Results provide concrete R² values, half-life estimates, and model parameters for each category.',
    ].join(' '),
    source: 'analysis:star-decay-benchmark',
    collectedAt: new Date().toISOString(),
    repoCount: analyses.length,
    data: {
      categories,
      generalFindings: findings,
      allAnalyses: analyses.map(a => ({
        repo: a.repo,
        category: a.category,
        peakDailyStars: a.peakDailyStars,
        daysToPeak: a.daysToPeak,
        bestModel: a.bestModel.type,
        bestR2: a.bestModel.r_squared,
        halfLife: a.halfLife,
        day30Prediction: a.day30Prediction,
        postPeakDataPoints: a.postPeakDataPoints,
        allModels: a.models.map(m => ({
          type: m.type,
          r2: m.r_squared,
          params: m.params,
        })),
      })),
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Summary report
// ═══════════════════════════════════════════════════════════════

function printSummaryReport(analyses: DecayAnalysis[]) {
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║                    DECAY MODEL RESULTS                         ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');

  for (const a of analyses) {
    console.log(`║ ${a.repo.padEnd(45)} ${a.category.padEnd(12)} ║`);
    console.log(`║   Peak: ${String(a.peakDailyStars).padEnd(6)}/day  Half-life: ${String(a.halfLife).padEnd(5)} days            ║`);
    for (const m of a.models) {
      const marker = m === a.bestModel ? '★' : ' ';
      console.log(`║   ${marker} ${m.type.padEnd(22)} R²=${m.r_squared.toFixed(4).padEnd(8)}              ║`);
    }
    console.log('║                                                                  ║');
  }

  // Overall winner
  const modelCounts: Record<string, number> = {};
  for (const a of analyses) {
    if (a.bestModel.r_squared > 0) {
      modelCounts[a.bestModel.type] = (modelCounts[a.bestModel.type] ?? 0) + 1;
    }
  }
  const winner = Object.entries(modelCounts).sort(([, a], [, b]) => b - a)[0];

  console.log('╠══════════════════════════════════════════════════════════════════╣');
  if (winner) {
    console.log(`║  🏆 Overall best model: ${winner[0].padEnd(20)} (won ${winner[1]}/${analyses.filter(a => a.bestModel.r_squared > 0).length} repos)    ║`);
  }
  console.log('╚══════════════════════════════════════════════════════════════════╝');
}

// ═══════════════════════════════════════════════════════════════
// Run
// ═══════════════════════════════════════════════════════════════

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});

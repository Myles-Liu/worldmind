/**
 * Decay Model Fitter
 *
 * Fits multiple candidate decay models to post-peak star history data
 * using pure TypeScript — no external numerical libraries.
 *
 * Models:
 *   1. Exponential:           y = a · e^(−λt)
 *   2. Power law:             y = a · t^(−α)            (t ≥ 1)
 *   3. Stretched exponential: y = a · e^(−(t/τ)^β)
 *   4. Log-normal pulse:      y = (a/t) · e^(−(ln t−μ)²/(2σ²))
 *
 * Fitting uses Nelder-Mead simplex optimisation of sum-of-squared-residuals.
 */

import type { StarHistory, StarDataPoint } from '../collectors/star-history.js';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type DecayModelType =
  | 'exponential'
  | 'power_law'
  | 'log_normal'
  | 'stretched_exponential';

export interface DecayModel {
  type: DecayModelType;
  params: Record<string, number>;
  r_squared: number;
  description: string;
}

export interface DecayAnalysis {
  repo: string;
  category: string; // 'influencer' | 'tool' | 'content' | 'platform' | 'generic'
  peakDailyStars: number;
  daysToPeak: number;
  models: DecayModel[];
  bestModel: DecayModel;
  halfLife: number;
  day30Prediction: number;
  totalDay30Prediction: number;
  /** Post-peak data used for fitting (for transparency) */
  postPeakDataPoints: number;
  analysedAt: string;
}

// ═══════════════════════════════════════════════════════════════
// Nelder-Mead Simplex Optimiser (pure TS)
// ═══════════════════════════════════════════════════════════════

interface NelderMeadOpts {
  maxIter?: number;
  tol?: number;
  initialStep?: number[];
}

/**
 * Minimise f(x) where x ∈ ℝⁿ using the Nelder-Mead simplex method.
 * Returns the parameter vector that minimises f.
 */
function nelderMead(
  f: (x: number[]) => number,
  x0: number[],
  opts: NelderMeadOpts = {},
): number[] {
  const n = x0.length;
  const maxIter = opts.maxIter ?? 2000;
  const tol = opts.tol ?? 1e-10;
  const step = opts.initialStep ?? x0.map(v => Math.max(Math.abs(v) * 0.1, 0.1));

  // Coefficients
  const alpha = 1.0; // reflection
  const gamma = 2.0; // expansion
  const rho = 0.5;   // contraction
  const sigma = 0.5;  // shrink

  // Build initial simplex: n+1 vertices
  const simplex: { x: number[]; fx: number }[] = [];
  simplex.push({ x: [...x0], fx: f(x0) });
  for (let i = 0; i < n; i++) {
    const xi = [...x0];
    xi[i]! += step[i]!;
    simplex.push({ x: xi, fx: f(xi) });
  }

  for (let iter = 0; iter < maxIter; iter++) {
    // Sort by function value
    simplex.sort((a, b) => a.fx - b.fx);

    // Check convergence
    const fRange = Math.abs(simplex[n]!.fx - simplex[0]!.fx);
    if (fRange < tol) break;

    // Centroid of all vertices except worst
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        centroid[j]! += simplex[i]!.x[j]!;
      }
    }
    for (let j = 0; j < n; j++) centroid[j]! /= n;

    const worst = simplex[n]!;

    // Reflection
    const xr = centroid.map((c, j) => c + alpha * (c - worst.x[j]!));
    const fxr = f(xr);

    if (fxr < simplex[0]!.fx) {
      // Expansion
      const xe = centroid.map((c, j) => c + gamma * (xr[j]! - c));
      const fxe = f(xe);
      if (fxe < fxr) {
        simplex[n] = { x: xe, fx: fxe };
      } else {
        simplex[n] = { x: xr, fx: fxr };
      }
    } else if (fxr < simplex[n - 1]!.fx) {
      simplex[n] = { x: xr, fx: fxr };
    } else {
      // Contraction
      const xc = centroid.map((c, j) => c + rho * (worst.x[j]! - c));
      const fxc = f(xc);
      if (fxc < worst.fx) {
        simplex[n] = { x: xc, fx: fxc };
      } else {
        // Shrink
        const best = simplex[0]!.x;
        for (let i = 1; i <= n; i++) {
          for (let j = 0; j < n; j++) {
            simplex[i]!.x[j] = best[j]! + sigma * (simplex[i]!.x[j]! - best[j]!);
          }
          simplex[i]!.fx = f(simplex[i]!.x);
        }
      }
    }
  }

  simplex.sort((a, b) => a.fx - b.fx);
  return simplex[0]!.x;
}

// ═══════════════════════════════════════════════════════════════
// R² and helpers
// ═══════════════════════════════════════════════════════════════

function rSquared(observed: number[], predicted: number[]): number {
  const n = observed.length;
  if (n === 0) return 0;
  const mean = observed.reduce((a, b) => a + b, 0) / n;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += (observed[i]! - mean) ** 2;
    ssRes += (observed[i]! - predicted[i]!) ** 2;
  }
  if (ssTot === 0) return 0;
  return 1 - ssRes / ssTot;
}

function sumSquaredResiduals(observed: number[], predicted: number[]): number {
  let ss = 0;
  for (let i = 0; i < observed.length; i++) {
    ss += (observed[i]! - predicted[i]!) ** 2;
  }
  return ss;
}

// Clamp to avoid NaN/Infinity
function clamp(v: number, lo: number, hi: number): number {
  if (!isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

// ═══════════════════════════════════════════════════════════════
// Model definitions
// ═══════════════════════════════════════════════════════════════

interface ModelDef {
  type: DecayModelType;
  /** Number of parameters */
  nParams: number;
  /** Generate initial guess from data */
  initialGuess: (t: number[], y: number[]) => number[];
  /** Predict y given params and t array */
  predict: (params: number[], t: number[]) => number[];
  /** Human-readable description of fitted model */
  describe: (params: number[]) => string;
  /** Parameter names (for output) */
  paramNames: string[];
  /** Optional parameter bounds enforced inside objective */
  clampParams?: (params: number[]) => number[];
}

const models: ModelDef[] = [
  // ─── Exponential decay: y = a * exp(-λ*t) ─────────────────
  {
    type: 'exponential',
    nParams: 2,
    paramNames: ['a', 'lambda'],
    initialGuess: (_t, y) => {
      const a = Math.max(...y);
      // Rough lambda estimate from first and last points
      const yLast = y[y.length - 1] ?? 1;
      const tLast = _t[_t.length - 1] ?? 1;
      const lambda = Math.max(0.001, -Math.log(Math.max(yLast, 0.1) / Math.max(a, 0.1)) / Math.max(tLast, 1));
      return [a, lambda];
    },
    clampParams: (p) => [Math.max(0.01, p[0]!), clamp(p[1]!, 1e-6, 10)],
    predict: (params, t) => {
      const [a, lambda] = params as [number, number];
      return t.map(ti => a * Math.exp(-lambda * ti));
    },
    describe: (p) => `y = ${p[0]!.toFixed(1)} · e^(-${p[1]!.toFixed(4)}·t)`,
  },

  // ─── Power law decay: y = a * t^(-α) ──────────────────────
  {
    type: 'power_law',
    nParams: 2,
    paramNames: ['a', 'alpha'],
    initialGuess: (_t, y) => {
      const a = y[0] ?? Math.max(...y);
      // Log-log linear regression for initial alpha
      const logT: number[] = [];
      const logY: number[] = [];
      for (let i = 0; i < _t.length; i++) {
        if (_t[i]! > 0 && y[i]! > 0) {
          logT.push(Math.log(_t[i]!));
          logY.push(Math.log(y[i]!));
        }
      }
      let alpha = 1;
      if (logT.length >= 2) {
        // Simple linear regression: logY = logA - alpha * logT
        const n = logT.length;
        const meanLogT = logT.reduce((a, b) => a + b, 0) / n;
        const meanLogY = logY.reduce((a, b) => a + b, 0) / n;
        let num = 0, den = 0;
        for (let i = 0; i < n; i++) {
          num += (logT[i]! - meanLogT) * (logY[i]! - meanLogY);
          den += (logT[i]! - meanLogT) ** 2;
        }
        alpha = den > 0 ? -num / den : 1;
      }
      return [Math.max(a, 1), clamp(alpha, 0.1, 5)];
    },
    clampParams: (p) => [Math.max(0.01, p[0]!), clamp(p[1]!, 0.01, 10)],
    predict: (params, t) => {
      const [a, alpha] = params as [number, number];
      return t.map(ti => a * Math.pow(Math.max(ti, 0.5), -alpha));
    },
    describe: (p) => `y = ${p[0]!.toFixed(1)} · t^(-${p[1]!.toFixed(3)})`,
  },

  // ─── Stretched exponential: y = a * exp(-(t/τ)^β) ─────────
  {
    type: 'stretched_exponential',
    nParams: 3,
    paramNames: ['a', 'tau', 'beta'],
    initialGuess: (_t, y) => {
      const a = Math.max(...y);
      const tMax = _t[_t.length - 1] ?? 30;
      const tau = tMax / 3;
      return [a, tau, 0.5];
    },
    clampParams: (p) => [Math.max(0.01, p[0]!), clamp(p[1]!, 0.1, 10000), clamp(p[2]!, 0.05, 2.0)],
    predict: (params, t) => {
      const [a, tau, beta] = params as [number, number, number];
      return t.map(ti => a * Math.exp(-Math.pow(ti / tau, beta)));
    },
    describe: (p) => `y = ${p[0]!.toFixed(1)} · e^(-(t/${p[1]!.toFixed(1)})^${p[2]!.toFixed(3)})`,
  },

  // ─── Log-normal pulse: y = (a/t) * exp(-(ln(t)-μ)²/(2σ²)) ──
  {
    type: 'log_normal',
    nParams: 3,
    paramNames: ['a', 'mu', 'sigma'],
    initialGuess: (_t, y) => {
      // Peak should be near e^(μ-σ²)
      let peakIdx = 0;
      for (let i = 1; i < y.length; i++) {
        if (y[i]! > y[peakIdx]!) peakIdx = i;
      }
      const tPeak = Math.max(_t[peakIdx] ?? 1, 1);
      const mu = Math.log(tPeak) + 0.5; // rough
      const sigma = 1.0;
      const a = (y[peakIdx] ?? 1) * tPeak * Math.exp(0.5);
      return [Math.max(a, 1), mu, sigma];
    },
    clampParams: (p) => [Math.max(0.01, p[0]!), clamp(p[1]!, -5, 15), clamp(p[2]!, 0.1, 10)],
    predict: (params, t) => {
      const [a, mu, sigma] = params as [number, number, number];
      const twoSig2 = 2 * sigma * sigma;
      return t.map(ti => {
        const ti_ = Math.max(ti, 0.5);
        return (a / ti_) * Math.exp(-((Math.log(ti_) - mu) ** 2) / twoSig2);
      });
    },
    describe: (p) => `y = (${p[0]!.toFixed(1)}/t) · e^(-(ln(t)-${p[1]!.toFixed(2)})²/(2·${p[2]!.toFixed(2)}²))`,
  },
];

// ═══════════════════════════════════════════════════════════════
// Fitting
// ═══════════════════════════════════════════════════════════════

function fitModel(
  modelDef: ModelDef,
  t: number[],
  y: number[],
): DecayModel {
  const guess = modelDef.initialGuess(t, y);

  // Objective: sum of squared residuals
  const objective = (params: number[]): number => {
    const clamped = modelDef.clampParams ? modelDef.clampParams(params) : params;
    const pred = modelDef.predict(clamped, t);
    let ss = 0;
    for (let i = 0; i < y.length; i++) {
      const r = y[i]! - (pred[i] ?? 0);
      if (!isFinite(r)) return 1e20;
      ss += r * r;
    }
    return ss;
  };

  // Run Nelder-Mead with multiple restarts
  let bestParams = guess;
  let bestSS = objective(guess);

  // Restart 1: original guess
  const nm1 = nelderMead(objective, guess, { maxIter: 3000 });
  const ss1 = objective(nm1);
  if (ss1 < bestSS) { bestParams = nm1; bestSS = ss1; }

  // Restart 2: perturbed guess
  const guess2 = guess.map(v => v * 1.5);
  const nm2 = nelderMead(objective, guess2, { maxIter: 3000 });
  const ss2 = objective(nm2);
  if (ss2 < bestSS) { bestParams = nm2; bestSS = ss2; }

  // Restart 3: another perturbation
  const guess3 = guess.map(v => v * 0.5);
  const nm3 = nelderMead(objective, guess3, { maxIter: 3000 });
  const ss3 = objective(nm3);
  if (ss3 < bestSS) { bestParams = nm3; bestSS = ss3; }

  // Clamp final params
  const finalParams = modelDef.clampParams ? modelDef.clampParams(bestParams) : bestParams;
  const predicted = modelDef.predict(finalParams, t);
  const r2 = rSquared(y, predicted);

  // Build param record
  const paramRecord: Record<string, number> = {};
  for (let i = 0; i < modelDef.paramNames.length; i++) {
    paramRecord[modelDef.paramNames[i]!] = finalParams[i]!;
  }

  return {
    type: modelDef.type,
    params: paramRecord,
    r_squared: r2,
    description: modelDef.describe(finalParams),
  };
}

// ═══════════════════════════════════════════════════════════════
// Half-life calculation
// ═══════════════════════════════════════════════════════════════

function computeHalfLife(model: DecayModel, peakDaily: number): number {
  // Binary search for t where predicted(t) = peakDaily / 2
  const target = peakDaily / 2;
  const modelDef = models.find(m => m.type === model.type);
  if (!modelDef) return NaN;

  const params = modelDef.paramNames.map(n => model.params[n] ?? 0);

  let lo = 1;
  let hi = 3650; // 10 years max

  for (let iter = 0; iter < 100; iter++) {
    const mid = (lo + hi) / 2;
    const pred = modelDef.predict(params, [mid])[0] ?? 0;
    if (pred > target) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 0.1) break;
  }

  return Math.round((lo + hi) / 2);
}

// ═══════════════════════════════════════════════════════════════
// Main analysis function
// ═══════════════════════════════════════════════════════════════

export function analyzeDecay(
  history: StarHistory,
  category: string,
): DecayAnalysis {
  const { dataPoints, repo, peakDate } = history;

  if (dataPoints.length < 3 || !peakDate) {
    return makeEmptyAnalysis(repo, category, history.peakDailyStars, 0);
  }

  // Find peak index
  let peakIdx = dataPoints.findIndex(dp => dp.date === peakDate);
  if (peakIdx < 0) {
    // Fallback: find the actual peak in the data
    let maxDaily = 0;
    for (let i = 0; i < dataPoints.length; i++) {
      if (dataPoints[i]!.dailyStars > maxDaily) {
        maxDaily = dataPoints[i]!.dailyStars;
        peakIdx = i;
      }
    }
    if (peakIdx < 0) {
      return makeEmptyAnalysis(repo, category, history.peakDailyStars, 0);
    }
  }

  const peakDailyStars = dataPoints[peakIdx]!.dailyStars;

  // Calculate days from first star to peak
  const actualPeakDate = dataPoints[peakIdx]!.date;
  const firstDate = new Date(dataPoints[0]?.date ?? actualPeakDate);
  const peakDateObj = new Date(actualPeakDate);
  const daysToPeak = Math.round((peakDateObj.getTime() - firstDate.getTime()) / 86400000);

  // Extract post-peak data
  // Start from day after peak, use t = days since peak
  const postPeak = dataPoints.slice(peakIdx + 1);

  // We need at least 5 data points to fit anything meaningful
  if (postPeak.length < 5) {
    console.log(`  ⚠️ Only ${postPeak.length} post-peak data points for ${repo}, using all data from peak.`);
    // Use from peak onwards
    const allFromPeak = dataPoints.slice(Math.max(0, peakIdx));
    if (allFromPeak.length < 3) {
      return makeEmptyAnalysis(repo, category, peakDailyStars, daysToPeak);
    }
  }

  const dataForFitting = postPeak.length >= 5 ? postPeak : dataPoints.slice(Math.max(0, peakIdx));

  // Build t (days since peak) and y (daily stars) arrays
  const peakDateMs = peakDateObj.getTime();
  const t: number[] = [];
  const y: number[] = [];

  for (const dp of dataForFitting) {
    const daysSincePeak = Math.round((new Date(dp.date).getTime() - peakDateMs) / 86400000);
    if (daysSincePeak < 1) continue; // skip peak day itself for decay fitting (t must be ≥ 1)
    t.push(daysSincePeak);
    y.push(Math.max(dp.dailyStars, 0));
  }

  if (t.length < 3) {
    return makeEmptyAnalysis(repo, category, peakDailyStars, daysToPeak);
  }

  console.log(`  🔬 Fitting decay models to ${t.length} post-peak data points...`);

  // Fit all models
  const fittedModels: DecayModel[] = [];
  for (const modelDef of models) {
    try {
      const fitted = fitModel(modelDef, t, y);
      fittedModels.push(fitted);
      console.log(`    ${modelDef.type}: R²=${fitted.r_squared.toFixed(4)} — ${fitted.description}`);
    } catch (e) {
      console.log(`    ${modelDef.type}: FAILED — ${(e as Error).message}`);
    }
  }

  // Sort by R² descending
  fittedModels.sort((a, b) => b.r_squared - a.r_squared);

  const bestModel = fittedModels[0] ?? {
    type: 'exponential' as DecayModelType,
    params: { a: peakDailyStars, lambda: 0.1 },
    r_squared: 0,
    description: 'fallback',
  };

  // Compute half-life using best model
  const halfLife = computeHalfLife(bestModel, peakDailyStars);

  // Day 30 prediction
  const bestModelDef = models.find(m => m.type === bestModel.type)!;
  const bestParams = bestModelDef.paramNames.map(n => bestModel.params[n] ?? 0);
  const day30Daily = bestModelDef.predict(bestParams, [30])[0] ?? 0;

  // Total stars at day 30: sum of predicted daily stars from day 1 to day 30
  const days1to30 = Array.from({ length: 30 }, (_, i) => i + 1);
  const predicted1to30 = bestModelDef.predict(bestParams, days1to30);
  const totalDay30 = predicted1to30.reduce((s, v) => s + v, 0) + history.totalStars;

  return {
    repo,
    category,
    peakDailyStars,
    daysToPeak,
    models: fittedModels,
    bestModel,
    halfLife,
    day30Prediction: Math.round(day30Daily),
    totalDay30Prediction: Math.round(totalDay30),
    postPeakDataPoints: t.length,
    analysedAt: new Date().toISOString(),
  };
}

function makeEmptyAnalysis(
  repo: string,
  category: string,
  peakDailyStars: number,
  daysToPeak: number,
): DecayAnalysis {
  return {
    repo,
    category,
    peakDailyStars,
    daysToPeak,
    models: [],
    bestModel: {
      type: 'exponential',
      params: {},
      r_squared: 0,
      description: 'insufficient data',
    },
    halfLife: NaN,
    day30Prediction: 0,
    totalDay30Prediction: 0,
    postPeakDataPoints: 0,
    analysedAt: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════
// Export model definitions for external use
// ═══════════════════════════════════════════════════════════════

export { models as MODEL_DEFINITIONS };

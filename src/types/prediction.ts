import { z } from 'zod';

// ─── Prediction Category ────────────────────────────────────────

export const PredictionCategory = z.enum([
  'growth',       // "Repo X will reach N stars by date Y"
  'adoption',     // "Tech A will surpass Tech B in metric M"
  'community',    // "Developer X will start contributing to project Y"
  'decline',      // "Framework Z will see >N% drop in new adoption"
  'emergence',    // "A new project in domain D will reach threshold T"
  'migration',    // "Ecosystem will shift from A to B"
]);
export type PredictionCategory = z.infer<typeof PredictionCategory>;

// ─── Prediction Status ──────────────────────────────────────────

export const PredictionStatus = z.enum([
  'draft',        // Created by Predict Agent, not yet challenged
  'challenged',   // Under review by Challenge Agent
  'active',       // Published — awaiting verification
  'verified',     // Timeframe elapsed, outcome determined
  'withdrawn',    // Retracted (e.g., after challenge)
  'expired',      // Timeframe elapsed without verification data
]);
export type PredictionStatus = z.infer<typeof PredictionStatus>;

// ─── Verification Outcome ───────────────────────────────────────

export const VerificationOutcome = z.enum([
  'correct',
  'partially_correct',
  'incorrect',
  'unverifiable',
]);
export type VerificationOutcome = z.infer<typeof VerificationOutcome>;

// ─── Evidence ───────────────────────────────────────────────────

export const Evidence = z.object({
  source: z.string(),       // Which agent or data source
  description: z.string(),
  strength: z.number().min(0).max(1),
  timestamp: z.string(),
});
export type Evidence = z.infer<typeof Evidence>;

// ─── Prediction ─────────────────────────────────────────────────

export const Prediction = z.object({
  id: z.string(),
  predictionText: z.string(),          // Human-readable prediction statement
  category: PredictionCategory,
  confidence: z.number().min(0).max(1),
  evidence: z.array(Evidence),
  reasoning: z.string(),               // Full reasoning chain
  timeframe: z.object({
    start: z.string(),                 // ISO 8601
    end: z.string(),                   // ISO 8601 — when to verify
  }),
  verificationCriteria: z.string(),    // How to check if this came true
  relatedEntities: z.array(z.string()),
  status: PredictionStatus,
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),               // Agent name
});
export type Prediction = z.infer<typeof Prediction>;

// ─── Challenge Report ───────────────────────────────────────────

export const ChallengeVerdict = z.enum([
  'approved',           // Prediction holds up
  'revised',            // Confidence adjusted
  'flagged',            // Significant concerns raised
  'rejected',           // Should be withdrawn
]);
export type ChallengeVerdict = z.infer<typeof ChallengeVerdict>;

export const ChallengeReport = z.object({
  id: z.string(),
  targetPredictionId: z.string(),
  verdict: ChallengeVerdict,
  counterEvidence: z.array(Evidence),
  logicalIssues: z.array(z.string()),
  biasFlags: z.array(z.string()),      // Identified cognitive biases
  revisedConfidence: z.number().min(0).max(1).nullable(),
  reasoning: z.string(),
  createdAt: z.string(),
});
export type ChallengeReport = z.infer<typeof ChallengeReport>;

// ─── Verification Record ────────────────────────────────────────

export const VerificationRecord = z.object({
  predictionId: z.string(),
  outcome: VerificationOutcome,
  actualResult: z.string(),            // What actually happened
  predictedConfidence: z.number(),     // What confidence was assigned
  notes: z.string(),
  verifiedAt: z.string(),
  verifiedBy: z.string(),             // 'system:validator' or 'human'
});
export type VerificationRecord = z.infer<typeof VerificationRecord>;

// ─── Calibration Metrics ────────────────────────────────────────

export interface CalibrationBucket {
  confidenceRange: [number, number];   // e.g., [0.6, 0.7]
  totalPredictions: number;
  correctPredictions: number;
  accuracy: number;                    // correctPredictions / totalPredictions
}

export interface CalibrationReport {
  agentName: string;
  period: { from: string; to: string };
  totalPredictions: number;
  overallAccuracy: number;
  buckets: CalibrationBucket[];
  brierScore: number;                  // Lower is better calibrated
  categoryBreakdown: Record<PredictionCategory, {
    total: number;
    accuracy: number;
  }>;
}

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface StoredPrediction {
  id: string;
  createdAt: string;
  cycle: number;
  statement: string;
  target: string;
  metric: string;
  currentValue: number;
  predictedValue: number;
  timeframeDays: number;
  confidence: number;
  revisedConfidence?: number;  // After challenge
  evidence: string[];
  reasoning: string;
  challenges?: string[];       // From Challenge Agent

  // Verification
  status: 'pending' | 'verified_correct' | 'verified_incorrect' | 'expired';
  verifiedAt?: string;
  actualValue?: number;
  verificationNote?: string;
}

export class PredictionStore {
  private predictions: StoredPrediction[] = [];
  private filePath: string;

  constructor(dataDir = 'data/predictions') {
    this.filePath = path.join(dataDir, 'predictions.json');
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      this.predictions = JSON.parse(content);
    } catch {
      this.predictions = [];
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.predictions, null, 2));
  }

  add(prediction: Omit<StoredPrediction, 'id' | 'status'>): void {
    this.predictions.push({
      ...prediction,
      id: `pred_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      status: 'pending',
    });
  }

  getPending(): StoredPrediction[] {
    return this.predictions.filter(p => p.status === 'pending');
  }

  getDue(): StoredPrediction[] {
    const now = Date.now();
    return this.predictions.filter(p => {
      if (p.status !== 'pending') return false;
      const createdAt = new Date(p.createdAt).getTime();
      const dueAt = createdAt + p.timeframeDays * 24 * 60 * 60 * 1000;
      return now >= dueAt;
    });
  }

  verify(id: string, actualValue: number, note?: string): void {
    const pred = this.predictions.find(p => p.id === id);
    if (!pred) return;

    // Simple verification: is actual value close to predicted?
    const ratio = pred.predictedValue !== 0 ? actualValue / pred.predictedValue : 0;
    const isCorrect = ratio >= 0.7 && ratio <= 1.3; // Within 30% tolerance

    pred.status = isCorrect ? 'verified_correct' : 'verified_incorrect';
    pred.verifiedAt = new Date().toISOString();
    pred.actualValue = actualValue;
    pred.verificationNote = note;
  }

  getStats(): { total: number; pending: number; correct: number; incorrect: number; accuracy: number } {
    const total = this.predictions.length;
    const pending = this.predictions.filter(p => p.status === 'pending').length;
    const correct = this.predictions.filter(p => p.status === 'verified_correct').length;
    const incorrect = this.predictions.filter(p => p.status === 'verified_incorrect').length;
    const verified = correct + incorrect;
    return {
      total,
      pending,
      correct,
      incorrect,
      accuracy: verified > 0 ? correct / verified : 0,
    };
  }

  // Format for Agent prompts — show past prediction track record
  formatTrackRecord(count = 10): string {
    const verified = this.predictions
      .filter(p => p.status !== 'pending')
      .slice(-count);

    if (verified.length === 0) return 'No verified predictions yet.';

    const stats = this.getStats();
    let result = `Track record: ${stats.correct}/${stats.correct + stats.incorrect} correct (${Math.round(stats.accuracy * 100)}% accuracy)\n`;
    result += verified.map(p =>
      `[${p.status === 'verified_correct' ? '✅' : '❌'}] "${p.statement}" — predicted: ${p.predictedValue}, actual: ${p.actualValue}`
    ).join('\n');

    return result;
  }

  get size(): number {
    return this.predictions.length;
  }
}

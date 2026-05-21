/**
 * Concern decay. Time-based exponential model: a record's decay_score is
 * exp(-Δt / τ) where Δt is the time since its last reinforcement (updated_at)
 * and τ is the half-life. Each reinforcement resets updated_at, so a repeatedly
 * confirmed concern stays near 1.0; a one-off drops below the floor (~130 days
 * at τ=30d, floor=0.05) and is deleted. Idempotent — recomputed from updated_at
 * each run, never compounded.
 *
 * Runs locally from the daemon's decay job (was a daily EventBridge Lambda).
 */
import type { KnowledgeStore } from '../../agents/common/src/store/store.js';

export interface DecayOptions {
  readonly halfLifeMs?: number;
  readonly floor?: number;
}

export interface DecayStats {
  readonly scanned: number;
  readonly decayed: number;
  readonly deleted: number;
}

const DEFAULT_HALF_LIFE_MS = 30 * 24 * 3600 * 1000;
const DEFAULT_FLOOR = 0.05;

export async function runDecay(store: KnowledgeStore, opts: DecayOptions = {}): Promise<DecayStats> {
  const halfLife = opts.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
  const floor = opts.floor ?? DEFAULT_FLOOR;
  const now = Date.now();

  let scanned = 0, decayed = 0, deleted = 0;
  for (const rec of await store.allConcerns()) {
    scanned++;
    const updatedAt = Date.parse(rec.updatedAt);
    const dt = Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : 0;
    const score = Math.exp(-dt / halfLife);
    if (score < floor) { await store.deleteConcern(rec.recordId); deleted++; }
    else { await store.setDecayScore(rec.recordId, score); decayed++; }
  }
  return { scanned, decayed, deleted };
}

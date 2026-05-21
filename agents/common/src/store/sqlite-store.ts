/**
 * SQLite memory backend (zero external dependency). Concerns + embeddings +
 * cursors + idempotency + skill-embedding cache in a per-repo SQLite file;
 * skills are markdown notes via MarkdownSkills. Methods are async to satisfy the
 * shared KnowledgeStore interface; the underlying better-sqlite3 calls are sync.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  type KnowledgeStore, type ConcernRecord, type NewConcern, type MergedConcernFields,
  type SkillNote, type NewSkillNote, type SkillStatus,
} from './store.js';
import { MarkdownSkills, repoSlug } from './markdown-skills.js';
import { randomUUID } from 'node:crypto';

function toBlob(v: number[]): Buffer {
  const f = Float32Array.from(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}
function fromBlob(b: Buffer): number[] {
  const f = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  return Array.from(f);
}
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

interface ConcernRow {
  record_id: string; area_bucket: string; area_json: string; subject: string;
  concern: string; context: string; reinforcement_count: number; decay_score: number;
  embedding: Buffer | null; created_at: string; updated_at: string;
}
function rowToRecord(r: ConcernRow): ConcernRecord {
  return {
    recordId: r.record_id, areaBucket: r.area_bucket, area: JSON.parse(r.area_json),
    subject: r.subject, concern: r.concern, context: r.context,
    reinforcementCount: r.reinforcement_count, decayScore: r.decay_score,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class SqliteStore implements KnowledgeStore {
  readonly repo: string;
  private readonly db: Database.Database;
  private readonly skills: MarkdownSkills;

  constructor(vaultPath: string, repo: string) {
    this.repo = repo;
    const slug = repoSlug(repo);
    this.skills = new MarkdownSkills(vaultPath, slug);
    const memoryDir = join(vaultPath, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    this.db = new Database(join(memoryDir, `${slug}.sqlite`));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS concerns (
        record_id TEXT PRIMARY KEY, area_bucket TEXT NOT NULL, area_json TEXT NOT NULL,
        subject TEXT NOT NULL, concern TEXT NOT NULL, context TEXT NOT NULL DEFAULT '',
        reinforcement_count INTEGER NOT NULL DEFAULT 1, decay_score REAL NOT NULL DEFAULT 1.0,
        embedding BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_concerns_bucket ON concerns(area_bucket);
      CREATE TABLE IF NOT EXISTS cursors (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skill_embeddings (slug TEXT PRIMARY KEY, text_hash TEXT NOT NULL, embedding BLOB NOT NULL);
    `);
  }

  async listConcerns(areaBucket: string, limit = 20): Promise<ConcernRecord[]> {
    const rows = this.db.prepare(
      `SELECT * FROM concerns WHERE area_bucket = ? ORDER BY reinforcement_count DESC, updated_at DESC LIMIT ?`,
    ).all(areaBucket, limit) as ConcernRow[];
    return rows.map(rowToRecord);
  }

  async getConcern(recordId: string): Promise<ConcernRecord | null> {
    const r = this.db.prepare(`SELECT * FROM concerns WHERE record_id = ?`).get(recordId) as ConcernRow | undefined;
    return r ? rowToRecord(r) : null;
  }

  async createConcern(rec: NewConcern): Promise<ConcernRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO concerns (record_id, area_bucket, area_json, subject, concern, context,
         reinforcement_count, decay_score, embedding, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1.0, ?, ?, ?)`,
    ).run(id, rec.areaBucket, JSON.stringify(rec.area), rec.subject, rec.concern, rec.context,
      rec.embedding ? toBlob(rec.embedding) : null, now, now);
    return (await this.getConcern(id))!;
  }

  async bumpConcern(recordId: string): Promise<ConcernRecord | null> {
    const info = this.db.prepare(
      `UPDATE concerns SET reinforcement_count = reinforcement_count + 1, decay_score = 1.0, updated_at = ? WHERE record_id = ?`,
    ).run(new Date().toISOString(), recordId);
    return info.changes ? this.getConcern(recordId) : null;
  }

  async mergeConcerns(targetId: string, sourceId: string, merged: MergedConcernFields): Promise<ConcernRecord | null> {
    if (targetId === sourceId) return null;
    const target = await this.getConcern(targetId);
    const source = await this.getConcern(sourceId);
    if (!target || !source) return null;
    const combined = target.reinforcementCount + source.reinforcementCount;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE concerns SET area_json = ?, subject = ?, concern = ?, context = ?,
           reinforcement_count = ?, decay_score = 1.0, embedding = NULL, updated_at = ? WHERE record_id = ?`,
      ).run(JSON.stringify(merged.area), merged.subject, merged.concern, merged.context, combined, now, targetId);
      this.db.prepare(`DELETE FROM concerns WHERE record_id = ?`).run(sourceId);
    })();
    return this.getConcern(targetId);
  }

  async deleteConcern(recordId: string): Promise<void> {
    this.db.prepare(`DELETE FROM concerns WHERE record_id = ?`).run(recordId);
  }

  async allConcerns(): Promise<ConcernRecord[]> {
    return (this.db.prepare(`SELECT * FROM concerns`).all() as ConcernRow[]).map(rowToRecord);
  }

  async setDecayScore(recordId: string, score: number): Promise<void> {
    this.db.prepare(`UPDATE concerns SET decay_score = ? WHERE record_id = ?`).run(score, recordId);
  }

  async nearestConcerns(embedding: number[], k: number): Promise<Array<{ record: ConcernRecord; score: number }>> {
    const rows = this.db.prepare(`SELECT * FROM concerns WHERE embedding IS NOT NULL`).all() as ConcernRow[];
    return rows
      .map((r) => ({ record: rowToRecord(r), score: cosine(embedding, fromBlob(r.embedding!)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  // skills — delegate to markdown
  async listSkills(statuses?: SkillStatus[]): Promise<SkillNote[]> { return this.skills.listSkills(statuses); }
  async readSkill(slug: string): Promise<SkillNote | null> { return this.skills.readSkill(slug); }
  async writeSkill(note: NewSkillNote): Promise<SkillNote> { return this.skills.writeSkill(note); }
  async setSkillStatus(slug: string, status: SkillStatus): Promise<boolean> { return this.skills.setSkillStatus(slug, status); }
  async readTextbook(): Promise<string | null> { return this.skills.readTextbook(); }
  async writeTextbook(body: string): Promise<void> { this.skills.writeTextbook(body); }

  async getSkillEmbedding(slug: string, textHash: string): Promise<number[] | null> {
    const r = this.db.prepare(`SELECT text_hash, embedding FROM skill_embeddings WHERE slug = ?`)
      .get(slug) as { text_hash: string; embedding: Buffer } | undefined;
    return r && r.text_hash === textHash ? fromBlob(r.embedding) : null;
  }

  async setSkillEmbedding(slug: string, textHash: string, embedding: number[]): Promise<void> {
    this.db.prepare(
      `INSERT INTO skill_embeddings (slug, text_hash, embedding) VALUES (?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET text_hash = excluded.text_hash, embedding = excluded.embedding`,
    ).run(slug, textHash, toBlob(embedding));
  }

  async getCursor(name: string): Promise<string | null> {
    const r = this.db.prepare(`SELECT value FROM cursors WHERE name = ?`).get(name) as { value: string } | undefined;
    return r?.value ?? null;
  }
  async setCursor(name: string, value: string): Promise<void> {
    this.db.prepare(
      `INSERT INTO cursors (name, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(name, value, new Date().toISOString());
  }
  async seen(key: string): Promise<boolean> {
    return !!this.db.prepare(`SELECT 1 FROM idempotency WHERE key = ?`).get(key);
  }
  async mark(key: string): Promise<void> {
    this.db.prepare(`INSERT OR IGNORE INTO idempotency (key, created_at) VALUES (?, ?)`).run(key, new Date().toISOString());
  }

  async close(): Promise<void> { this.db.close(); }
}

/**
 * SurrealDB memory backend. Concerns + embeddings + cursors + idempotency live
 * in SurrealDB; nearest-concern dedup uses Surreal's native
 * `vector::similarity::cosine`. One Surreal database per repo (namespace
 * "reviewer", database "<owner>__<repo>"). Skills remain markdown notes in the
 * vault via MarkdownSkills.
 */
import { Surreal } from 'surrealdb';
import { randomUUID } from 'node:crypto';

import {
  type KnowledgeStore, type ConcernRecord, type NewConcern, type MergedConcernFields,
  type SkillNote, type NewSkillNote, type SkillStatus,
} from './store.js';
import { MarkdownSkills, repoSlug } from './markdown-skills.js';

export interface SurrealConfig {
  readonly url: string;
  readonly namespace: string;
  readonly username?: string;
  readonly password?: string;
}

/** Allow only safe identifier chars before interpolating into a DEFINE statement. */
function ident(s: string): string {
  // GitHub owner/repo allow [A-Za-z0-9._-]; backtick-quoting handles these. Block backtick/space/etc.
  if (!/^[A-Za-z0-9_.-]+$/.test(s)) throw new Error(`unsafe surreal identifier: ${s}`);
  return s;
}

function mapConcern(row: any): ConcernRecord {
  return {
    recordId: row.record_id,
    areaBucket: row.area_bucket,
    area: Array.isArray(row.area) ? row.area : [],
    subject: row.subject,
    concern: row.concern,
    context: row.context ?? '',
    reinforcementCount: Number(row.reinforcement_count ?? 0),
    decayScore: Number(row.decay_score ?? 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SurrealStore implements KnowledgeStore {
  readonly repo: string;
  private readonly db = new Surreal();
  private readonly skills: MarkdownSkills;
  private readonly cfg: SurrealConfig;
  private readonly database: string;

  constructor(vaultPath: string, repo: string, cfg: SurrealConfig) {
    this.repo = repo;
    this.cfg = cfg;
    this.database = repoSlug(repo);
    this.skills = new MarkdownSkills(vaultPath, repoSlug(repo));
  }

  /** Connect, ensure the per-repo namespace/database exist, and select them. */
  async connect(): Promise<void> {
    await this.db.connect(this.cfg.url);
    if (this.cfg.username) await this.db.signin({ username: this.cfg.username, password: this.cfg.password ?? '' });
    const ns = ident(this.cfg.namespace);
    const dbName = ident(this.database);
    // SurrealDB v3 doesn't auto-create on USE; define them first (DEFINE name can't be parameterized).
    await this.db.query(`DEFINE NAMESPACE IF NOT EXISTS \`${ns}\``);
    await this.db.use({ namespace: this.cfg.namespace });
    await this.db.query(`DEFINE DATABASE IF NOT EXISTS \`${dbName}\``);
    await this.selectDatabase();
    // Define tables so reads before first write return [] instead of erroring (v3 strict).
    await this.db.query(`
      DEFINE TABLE IF NOT EXISTS concern SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS cursor SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS seen SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS skill_embedding SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS counter SCHEMALESS;
    `);
  }

  private async selectDatabase(): Promise<void> {
    await this.db.use({ namespace: this.cfg.namespace, database: this.database });
  }

  private async rows(sql: string, vars?: Record<string, unknown>): Promise<any[]> {
    await this.selectDatabase();
    const res = (await this.db.query(sql, vars)) as unknown[];
    return (res[res.length - 1] as any[]) ?? [];
  }

  async listConcerns(areaBucket: string, limit = 20): Promise<ConcernRecord[]> {
    const rows = await this.rows(
      `SELECT * FROM concern WHERE area_bucket = $b ORDER BY reinforcement_count DESC, updated_at DESC LIMIT $limit`,
      { b: areaBucket, limit },
    );
    return rows.map(mapConcern);
  }

  async getConcern(recordId: string): Promise<ConcernRecord | null> {
    const rows = await this.rows(`SELECT * FROM concern WHERE record_id = $id LIMIT 1`, { id: recordId });
    return rows[0] ? mapConcern(rows[0]) : null;
  }

  async createConcern(rec: NewConcern): Promise<ConcernRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.rows(`CREATE concern CONTENT $data`, {
      data: {
        record_id: id, area_bucket: rec.areaBucket, area: rec.area, subject: rec.subject,
        concern: rec.concern, context: rec.context, reinforcement_count: 1, decay_score: 1.0,
        embedding: rec.embedding ?? null, created_at: now, updated_at: now,
      },
    });
    return (await this.getConcern(id))!;
  }

  async bumpConcern(recordId: string): Promise<ConcernRecord | null> {
    const rows = await this.rows(
      `UPDATE concern SET reinforcement_count += 1, decay_score = 1.0, updated_at = $now WHERE record_id = $id RETURN AFTER`,
      { now: new Date().toISOString(), id: recordId },
    );
    return rows[0] ? mapConcern(rows[0]) : null;
  }

  async mergeConcerns(targetId: string, sourceId: string, merged: MergedConcernFields): Promise<ConcernRecord | null> {
    if (targetId === sourceId) return null;
    const target = await this.getConcern(targetId);
    const source = await this.getConcern(sourceId);
    if (!target || !source) return null;
    const combined = target.reinforcementCount + source.reinforcementCount;
    await this.rows(
      `UPDATE concern SET area = $area, subject = $subject, concern = $concern, context = $context,
         reinforcement_count = $count, decay_score = 1.0, embedding = NONE, updated_at = $now WHERE record_id = $id`,
      { area: merged.area, subject: merged.subject, concern: merged.concern, context: merged.context, count: combined, now: new Date().toISOString(), id: targetId },
    );
    await this.rows(`DELETE concern WHERE record_id = $id`, { id: sourceId });
    return this.getConcern(targetId);
  }

  async deleteConcern(recordId: string): Promise<void> {
    await this.rows(`DELETE concern WHERE record_id = $id`, { id: recordId });
  }

  async allConcerns(): Promise<ConcernRecord[]> {
    return (await this.rows(`SELECT * FROM concern`)).map(mapConcern);
  }

  async setDecayScore(recordId: string, score: number): Promise<void> {
    await this.rows(`UPDATE concern SET decay_score = $s WHERE record_id = $id`, { s: score, id: recordId });
  }

  async nearestConcerns(embedding: number[], k: number): Promise<Array<{ record: ConcernRecord; score: number }>> {
    const rows = await this.rows(
      `SELECT *, vector::similarity::cosine(embedding, $q) AS score FROM concern
         WHERE embedding != NONE ORDER BY score DESC LIMIT $k`,
      { q: embedding, k },
    );
    return rows.map((r) => ({ record: mapConcern(r), score: Number(r.score ?? 0) }));
  }

  // skills — markdown
  async listSkills(statuses?: SkillStatus[]): Promise<SkillNote[]> { return this.skills.listSkills(statuses); }
  async readSkill(slug: string): Promise<SkillNote | null> { return this.skills.readSkill(slug); }
  async writeSkill(note: NewSkillNote): Promise<SkillNote> { return this.skills.writeSkill(note); }
  async setSkillStatus(slug: string, status: SkillStatus): Promise<boolean> { return this.skills.setSkillStatus(slug, status); }
  async readTextbook(): Promise<string | null> { return this.skills.readTextbook(); }
  async writeTextbook(body: string): Promise<void> { this.skills.writeTextbook(body); }

  async getSkillEmbedding(slug: string, textHash: string): Promise<number[] | null> {
    const rows = await this.rows(`SELECT text_hash, embedding FROM type::record('skill_embedding', $slug)`, { slug });
    const r = rows[0];
    return r && r.text_hash === textHash ? (r.embedding as number[]) : null;
  }
  async setSkillEmbedding(slug: string, textHash: string, embedding: number[]): Promise<void> {
    await this.rows(`UPSERT type::record('skill_embedding', $slug) SET text_hash = $h, embedding = $e`, { slug, h: textHash, e: embedding });
  }

  async getCursor(name: string): Promise<string | null> {
    const rows = await this.rows(`SELECT val FROM type::record('cursor', $n)`, { n: name });
    return rows[0]?.val ?? null;
  }
  async setCursor(name: string, value: string): Promise<void> {
    await this.rows(`UPSERT type::record('cursor', $n) SET val = $v, updated_at = $now`, { n: name, v: value, now: new Date().toISOString() });
  }
  async seen(key: string): Promise<boolean> {
    const rows = await this.rows(`SELECT id FROM type::record('seen', $k)`, { k: key });
    return rows.length > 0;
  }
  async mark(key: string): Promise<void> {
    await this.rows(`UPSERT type::record('seen', $k) SET at = $now`, { k: key, now: new Date().toISOString() });
  }

  async incrCounter(key: string, by = 1): Promise<number> {
    const rows = await this.rows(`UPSERT type::record('counter', $k) SET n = (n ?? 0) + $by RETURN AFTER`, { k: key, by });
    return Number(rows[0]?.n ?? by);
  }
  async getCounter(key: string): Promise<number> {
    const rows = await this.rows(`SELECT n FROM type::record('counter', $k)`, { k: key });
    return Number(rows[0]?.n ?? 0);
  }

  async close(): Promise<void> { await this.db.close(); }
}

/**
 * KnowledgeStore — the external, user-viewable home for a reviewer's memory.
 *
 * One store per reviewed repo. Skills (the curated textbook + graduated topic
 * skills) always live as markdown notes the user can read/edit (Obsidian vault).
 * The structured memory — concerns (pre-graduation findings), embeddings,
 * cursors, idempotency — lives in a pluggable backend: SQLite sidecar
 * (`backend: "sqlite"`) or SurrealDB (`backend: "surreal"`, native vector search).
 *
 * The interface is async so the SurrealDB backend (network/embedded, async SDK)
 * fits the same shape as the synchronous SQLite one.
 */

export interface ConcernRecord {
  readonly recordId: string;
  readonly areaBucket: string;
  readonly area: string[];
  readonly subject: string;
  readonly concern: string;
  readonly context: string;
  readonly reinforcementCount: number;
  readonly decayScore: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewConcern {
  readonly areaBucket: string;
  readonly area: string[];
  readonly subject: string;
  readonly concern: string;
  readonly context: string;
  /** Optional embedding of subject+concern for similarity dedup. */
  readonly embedding?: number[];
}

export interface MergedConcernFields {
  readonly area: string[];
  readonly subject: string;
  readonly concern: string;
  readonly context: string;
}

export type SkillStatus = 'draft' | 'active';

export interface SkillNote {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly status: SkillStatus;
  /** File-glob patterns this skill applies to (used for area-glob selection). */
  readonly area: string[];
  /** Provenance: the concern record_id this graduated from, if any. */
  readonly sourceRecord?: string;
  /** Markdown body (without frontmatter). */
  readonly body: string;
}

export interface NewSkillNote {
  readonly subject: string;
  readonly description: string;
  readonly area: string[];
  readonly body: string;
  readonly status?: SkillStatus;
  readonly sourceRecord?: string;
}

export interface KnowledgeStore {
  readonly repo: string;

  // --- concerns -----------------------------------------------------------
  listConcerns(areaBucket: string, limit?: number): Promise<ConcernRecord[]>;
  getConcern(recordId: string): Promise<ConcernRecord | null>;
  createConcern(rec: NewConcern): Promise<ConcernRecord>;
  bumpConcern(recordId: string): Promise<ConcernRecord | null>;
  mergeConcerns(targetId: string, sourceId: string, merged: MergedConcernFields): Promise<ConcernRecord | null>;
  deleteConcern(recordId: string): Promise<void>;
  allConcerns(): Promise<ConcernRecord[]>;
  setDecayScore(recordId: string, score: number): Promise<void>;
  /** k nearest by cosine over stored embeddings (only records that have one). */
  nearestConcerns(embedding: number[], k: number): Promise<Array<{ record: ConcernRecord; score: number }>>;

  // --- skills (markdown notes) -------------------------------------------
  listSkills(statuses?: SkillStatus[]): Promise<SkillNote[]>;
  readSkill(slug: string): Promise<SkillNote | null>;
  writeSkill(note: NewSkillNote): Promise<SkillNote>;
  setSkillStatus(slug: string, status: SkillStatus): Promise<boolean>;
  readTextbook(): Promise<string | null>;
  writeTextbook(body: string): Promise<void>;
  /** Cached embedding for a skill, keyed by a content hash for invalidation. */
  getSkillEmbedding(slug: string, textHash: string): Promise<number[] | null>;
  setSkillEmbedding(slug: string, textHash: string, embedding: number[]): Promise<void>;

  // --- cursors + idempotency ---------------------------------------------
  getCursor(name: string): Promise<string | null>;
  setCursor(name: string, value: string): Promise<void>;
  seen(key: string): Promise<boolean>;
  /** Atomically mark `key` as claimed; returns false if it already exists. */
  claim(key: string): Promise<boolean>;
  /** Release a previously claimed `key` so a failed operation can be retried. */
  unclaim(key: string): Promise<void>;
  mark(key: string): Promise<void>;

  // --- daily counters (rate/token limits) --------------------------------
  /** Atomically add `by` (default 1) to a counter and return the new total. */
  incrCounter(key: string, by?: number): Promise<number>;
  getCounter(key: string): Promise<number>;

  close(): Promise<void>;
}

/** kebab-case slug from a subject/title, stable across re-graduations. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

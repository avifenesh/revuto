/**
 * Skill notes as markdown files in the vault — shared by every memory backend
 * (SQLite, SurrealDB). Skills stay human-viewable/editable in Obsidian; only the
 * structured memory differs per backend.
 *
 *   <vault>/skills/<owner>__<repo>/_textbook.md   curated per-repo skill
 *   <vault>/skills/<owner>__<repo>/<slug>.md      graduated topic skills (draft|active)
 */
import matter from 'gray-matter';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type SkillNote, type NewSkillNote, type SkillStatus, slugify } from './store.js';
import { parseFrontMatter } from './front-matter.js';
import { sanitizeNote } from '../outbound.js';

/** A slug for a subject: punctuation-only subjects get a stable hash instead of an empty name. */
export function skillSlug(subject: string): string {
  return slugify(subject) || `skill-${createHash('sha256').update(subject).digest('hex').slice(0, 8)}`;
}

export class MarkdownSkills {
  readonly skillsDir: string;
  private readonly textbookPath: string;

  constructor(vaultPath: string, repoSlug: string) {
    this.skillsDir = join(vaultPath, 'skills', repoSlug);
    this.textbookPath = join(this.skillsDir, '_textbook.md');
    mkdirSync(this.skillsDir, { recursive: true });
  }

  listSkills(statuses?: SkillStatus[]): SkillNote[] {
    if (!existsSync(this.skillsDir)) return [];
    const out: SkillNote[] = [];
    for (const f of readdirSync(this.skillsDir)) {
      if (!f.endsWith('.md') || f === '_textbook.md') continue;
      const note = this.readSkill(f.slice(0, -3));
      if (note && (!statuses || statuses.includes(note.status))) out.push(note);
    }
    return out;
  }

  readSkill(slug: string): SkillNote | null {
    const p = join(this.skillsDir, `${slug}.md`);
    if (!existsSync(p)) return null;
    const parsed = parseFrontMatter(readFileSync(p, 'utf8'));
    if (!parsed) {
      console.warn(`[skills] ${p}: front matter is not YAML; the note is skipped`);
      return null;
    }
    const d = parsed.data;
    return {
      slug,
      name: String(d.name ?? slug),
      description: String(d.description ?? ''),
      status: d.status === 'active' ? 'active' : 'draft',
      area: Array.isArray(d.area) ? d.area.map(String) : [],
      sourceRecord: d.source_record ? String(d.source_record) : undefined,
      body: parsed.content.trim(),
    };
  }

  /**
   * Write a graduated skill. Revising an existing skill keeps the old note under
   * `_history/`, and a draft never replaces an active skill: it is written next to
   * it as `<slug>-revision` so the vetted version keeps serving reviews.
   */
  writeSkill(note: NewSkillNote): SkillNote {
    const base = skillSlug(note.subject);
    const status = note.status ?? 'draft';
    // A draft moves past every active note in its line: <slug>, <slug>-revision, <slug>-revision-2, ...
    let slug = base;
    for (let n = 1; status === 'draft' && this.readSkill(slug)?.status === 'active'; n++) {
      slug = n === 1 ? `${base}-revision` : `${base}-revision-${n}`;
    }
    // Whatever the destination held is archived before it is replaced.
    if (existsSync(join(this.skillsDir, `${slug}.md`))) {
      const history = join(this.skillsDir, '_history');
      mkdirSync(history, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      let n = 0;
      while (existsSync(join(history, `${slug}-${stamp}${n ? `-${n}` : ''}.md`))) n++;
      copyFileSync(join(this.skillsDir, `${slug}.md`), join(history, `${slug}-${stamp}${n ? `-${n}` : ''}.md`));
    }
    return this.writeNote(slug, { description: note.description, area: note.area, body: note.body, status, sourceRecord: note.sourceRecord });
  }

  setSkillStatus(slug: string, status: SkillStatus): boolean {
    const note = this.readSkill(slug);
    if (!note) return false;
    this.writeNote(slug, { description: note.description, area: note.area, body: note.body, status, sourceRecord: note.sourceRecord });
    return true;
  }

  /** Write the note file for `slug` exactly, without re-deriving the name. */
  private writeNote(slug: string, note: { description: string; area: readonly string[]; body: string; status: SkillStatus; sourceRecord?: string }): SkillNote {
    const data: Record<string, unknown> = { name: slug, description: note.description, status: note.status, area: note.area };
    if (note.sourceRecord) data.source_record = note.sourceRecord;
    writeFileSync(join(this.skillsDir, `${slug}.md`), matter.stringify(`${sanitizeNote(note.body).trim()}\n`, data), 'utf8');
    return this.readSkill(slug)!;
  }

  readTextbook(): string | null {
    return existsSync(this.textbookPath) ? readFileSync(this.textbookPath, 'utf8') : null;
  }

  writeTextbook(body: string): void {
    const clean = sanitizeNote(body);
    writeFileSync(this.textbookPath, clean.endsWith('\n') ? clean : `${clean}\n`, 'utf8');
  }
}

/**
 * Embedding cache key for a skill: its selection-relevant text (name+description+area)
 * plus the embedder id, so switching embedding models invalidates the cache.
 */
export function skillTextHash(name: string, description: string, area: string[], embedderId: string): string {
  return createHash('sha1').update(`${embedderId}\n${name}\n${description}\n${area.join(',')}`).digest('hex');
}

export function repoSlug(repo: string): string {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`bad repo: ${repo}`);
  return `${owner}__${name}`;
}

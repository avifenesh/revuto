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
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type SkillNote, type NewSkillNote, type SkillStatus, slugify } from './store.js';

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
    const parsed = matter(readFileSync(p, 'utf8'));
    const d = parsed.data as Record<string, unknown>;
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

  writeSkill(note: NewSkillNote): SkillNote {
    const slug = slugify(note.subject);
    const data: Record<string, unknown> = {
      name: slug,
      description: note.description,
      status: note.status ?? 'draft',
      area: note.area,
    };
    if (note.sourceRecord) data.source_record = note.sourceRecord;
    writeFileSync(join(this.skillsDir, `${slug}.md`), matter.stringify(`${note.body.trim()}\n`, data), 'utf8');
    return this.readSkill(slug)!;
  }

  setSkillStatus(slug: string, status: SkillStatus): boolean {
    const note = this.readSkill(slug);
    if (!note) return false;
    this.writeSkill({ subject: slug, description: note.description, area: note.area, body: note.body, status, sourceRecord: note.sourceRecord });
    return true;
  }

  readTextbook(): string | null {
    return existsSync(this.textbookPath) ? readFileSync(this.textbookPath, 'utf8') : null;
  }

  writeTextbook(body: string): void {
    writeFileSync(this.textbookPath, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
  }
}

/** Hash a skill's selection-relevant text (name+description+area) for embedding cache keys. */
export function skillTextHash(name: string, description: string, area: string[]): string {
  return createHash('sha1').update(`${name}\n${description}\n${area.join(',')}`).digest('hex');
}

export function repoSlug(repo: string): string {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`bad repo: ${repo}`);
  return `${owner}__${name}`;
}

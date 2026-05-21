/**
 * Skill selection: given a PR's touched files, return the per-repo textbook plus
 * the topic skills relevant to this diff, rendered as a markdown block for the
 * reviewer's system prompt.
 *
 * With an embedder: cosine similarity between the touched-area query and each
 * skill's (name + description + area) embedding. Without one: area-glob match of
 * each skill's `area` patterns against the touched files. Only `active` skills
 * are loaded — `draft` skills await human approval.
 */
import type { KnowledgeStore, SkillNote } from '../store/store.js';
import { skillTextHash } from '../store/markdown-skills.js';
import type { Embedder } from '../memory/embedder.js';

/** Minimal glob → RegExp supporting `**`, `*`, `?`. Matches POSIX-style paths. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else { re += '.*'; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function globMatches(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

/** Query string from touched files: top-level dirs + one-deeper shared roots. */
function buildQuery(files: readonly string[]): string {
  const tokens = new Set<string>();
  for (const f of files) {
    const parts = f.split('/').filter(Boolean);
    if (parts.length > 0) tokens.add(parts[0]);
    if (parts.length >= 2) tokens.add(`${parts[0]}/${parts[1]}`);
  }
  return [...tokens].join(' ');
}

async function selectByEmbedding(
  store: KnowledgeStore,
  embedder: Embedder,
  skills: SkillNote[],
  touchedFiles: readonly string[],
  topN: number,
  minScore: number,
): Promise<SkillNote[]> {
  const query = buildQuery(touchedFiles);
  if (!query) return [];

  // Embed any skills whose cached embedding is missing/stale, in one batch.
  const need: { skill: SkillNote; hash: string; text: string }[] = [];
  const cached = new Map<string, number[]>();
  for (const s of skills) {
    const hash = skillTextHash(s.name, s.description, s.area);
    const hit = await store.getSkillEmbedding(s.slug, hash);
    if (hit) cached.set(s.slug, hit);
    else need.push({ skill: s, hash, text: `${s.name}\n${s.description}\n${s.area.join(' ')}` });
  }
  if (need.length) {
    const vecs = await embedder.embed(need.map((n) => n.text));
    for (let i = 0; i < need.length; i++) {
      await store.setSkillEmbedding(need[i].skill.slug, need[i].hash, vecs[i]);
      cached.set(need[i].skill.slug, vecs[i]);
    }
  }

  const [qvec] = await embedder.embed([query]);
  const cos = (a: number[], b: number[]): number => {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  };
  return skills
    .map((s) => ({ s, score: cos(qvec, cached.get(s.slug) ?? []) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((x) => x.s);
}

function selectByGlob(skills: SkillNote[], touchedFiles: readonly string[]): SkillNote[] {
  return skills.filter((s) => s.area.some((pat) => touchedFiles.some((f) => globMatches(pat, f))));
}

export interface SelectOptions {
  readonly topN?: number;
  readonly minScore?: number;
}

/** Returns a markdown block (textbook + matched topic skills), or '' if nothing applies. */
export async function selectSkills(
  store: KnowledgeStore,
  embedder: Embedder | null,
  touchedFiles: readonly string[],
  opts: SelectOptions = {},
): Promise<string> {
  const textbook = ((await store.readTextbook()) ?? '').trim();
  const skills = await store.listSkills(['active']);

  const chosen = embedder && skills.length
    ? await selectByEmbedding(store, embedder, skills, touchedFiles, opts.topN ?? 8, opts.minScore ?? 0.2)
    : selectByGlob(skills, touchedFiles);

  if (!textbook && chosen.length === 0) return '';

  const out: string[] = [];
  if (textbook) out.push(textbook);
  if (chosen.length) {
    out.push('', '## Topic skills (graduated from repeated review feedback)', '');
    for (const s of chosen) {
      out.push(`### ${s.name}`);
      if (s.description) out.push(`_${s.description}_`, '');
      out.push(s.body, '');
    }
  }
  return out.join('\n').trim();
}

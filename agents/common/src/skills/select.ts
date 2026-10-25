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
import { cosine } from '../memory/vector.js';

type GlobToken = { kind: 'lit'; ch: string } | { kind: 'star' } | { kind: 'globstar' } | { kind: 'dirstar' } | { kind: 'one' };

/** Tokens of a glob: `**\/` (zero or more directories), `**`, `*`, `?` and literals. */
function globTokens(glob: string): GlobToken[] {
  const out: GlobToken[] = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; out.push({ kind: 'dirstar' }); } else out.push({ kind: 'globstar' });
    } else if (c === '*') out.push({ kind: 'star' });
    else if (c === '?') out.push({ kind: 'one' });
    else out.push({ kind: 'lit', ch: c });
  }
  return out;
}

/**
 * Glob match with `**`, `*`, `?` on POSIX-style paths, in O(path x pattern) time.
 * Area globs come from learned concerns, so a regex built from them could be
 * made to backtrack for seconds on a long path and stall the daemon.
 */
export function globMatches(pattern: string, path: string): boolean {
  const tokens = globTokens(pattern);
  const n = path.length;
  // reach[j]: the tokens so far can match path[0..j).
  let reach = new Array<boolean>(n + 1).fill(false);
  reach[0] = true;
  for (const t of tokens) {
    const next = new Array<boolean>(n + 1).fill(false);
    if (t.kind === 'lit' || t.kind === 'one') {
      for (let j = 0; j < n; j++) if (reach[j] && (t.kind === 'one' ? path[j] !== '/' : path[j] === t.ch)) next[j + 1] = true;
    } else if (t.kind === 'star') {
      for (let j = 0; j <= n; j++) {
        if (reach[j] || (j > 0 && next[j - 1] && path[j - 1] !== '/')) next[j] = true;
      }
    } else if (t.kind === 'globstar') {
      for (let j = 0; j <= n; j++) if (reach[j] || (j > 0 && next[j - 1])) next[j] = true;
    } else {
      // dirstar: nothing, or any run of characters ending in '/'.
      let open = false;
      for (let j = 0; j <= n; j++) {
        if (reach[j]) { next[j] = true; open = true; }
        if (j > 0 && open && path[j - 1] === '/') next[j] = true;
      }
    }
    reach = next;
  }
  return reach[n]!;
}

/** Area globs a concern may carry: a few, short, with a bounded number of wildcards. */
export function validAreaGlobs(area: readonly string[]): string | null {
  if (area.length > 20) return 'at most 20 area globs';
  for (const glob of area) {
    if (glob.length > 200) return `area glob longer than 200 characters: ${glob.slice(0, 40)}…`;
    if ((glob.match(/\*+|\?/g) ?? []).length > 10) return `area glob with more than 10 wildcards: ${glob.slice(0, 40)}…`;
  }
  return null;
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
    const hash = skillTextHash(s.name, s.description, s.area, embedder.id);
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
  return skills
    .map((s) => ({ s, score: cosine(qvec, cached.get(s.slug) ?? []) }))
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

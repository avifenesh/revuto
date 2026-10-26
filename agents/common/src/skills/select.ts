/**
 * Skill selection: given a PR's touched files, return the per-repo textbook plus
 * the topic skills relevant to this diff, rendered as a markdown block for the
 * reviewer's system prompt.
 *
 * With an embedder: cosine similarity between the touched-area query and each
 * skill's (name + description + area) embedding. Without one: area-glob match of
 * each skill's `area` patterns against the touched files, which is also what an
 * embedder error falls back to. Only `active` skills are loaded; `draft`
 * skills await human approval.
 */
import type { KnowledgeStore, SkillNote } from '../store/store.js';
import { skillTextHash } from '../store/markdown-skills.js';
import { type Embedder, embedInputLimit } from '../memory/embedder.js';
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

/**
 * Query string from touched files: top-level dirs + one-deeper shared roots,
 * the most-touched first, as many whole terms as fit in `maxChars`. A wide PR
 * touches more areas than an embedder window holds (agent-sh/agentsys#439 had
 * 138 terms, 1,413 tokens against a 512-token bge-small), and the areas most of
 * the diff lives in say the most about it.
 */
function buildQuery(files: readonly string[], maxChars: number): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const parts = f.split('/').filter(Boolean);
    const terms = parts.length >= 2 ? [parts[0], `${parts[0]}/${parts[1]}`] : parts.slice(0, 1);
    for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  // Stable sort: equal counts keep first-touched order.
  const ranked = [...counts].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const out: string[] = [];
  let len = 0;
  for (const t of ranked) {
    const add = (out.length ? 1 : 0) + t.length;
    if (len + add > maxChars) continue;
    out.push(t);
    len += add;
  }
  return out.join(' ');
}

/** Topic skills by embedding similarity, or null when there is no query to embed. */
async function selectByEmbedding(
  store: KnowledgeStore,
  embedder: Embedder,
  skills: SkillNote[],
  touchedFiles: readonly string[],
  topN: number,
  minScore: number,
): Promise<SkillNote[] | null> {
  const limit = embedInputLimit(embedder);
  const query = buildQuery(touchedFiles, limit);
  if (!query) return touchedFiles.length ? null : [];

  // Embed any skills whose cached embedding is missing/stale, in one batch.
  const need: { skill: SkillNote; hash: string; text: string }[] = [];
  const cached = new Map<string, number[]>();
  for (const s of skills) {
    const text = `${s.name}\n${s.description}\n${s.area.join(' ')}`;
    // The embedder cuts a text over its limit, so the vector of a long skill
    // depends on the limit too: key it on the limit, or a changed limit would
    // keep serving the old cut.
    const id = text.length > limit ? `${embedder.id}@${limit}` : embedder.id;
    const hash = skillTextHash(s.name, s.description, s.area, id);
    const hit = await store.getSkillEmbedding(s.slug, hash);
    if (hit) cached.set(s.slug, hit);
    else need.push({ skill: s, hash, text });
  }
  if (need.length) {
    const vecs = await embedder.embed(need.map((n) => n.text));
    if (vecs.length !== need.length) throw new Error(`embedder returned ${vecs.length} vectors for ${need.length} skills`);
    for (let i = 0; i < need.length; i++) {
      await store.setSkillEmbedding(need[i].skill.slug, need[i].hash, vecs[i]);
      cached.set(need[i].skill.slug, vecs[i]);
    }
  }

  const [qvec] = await embedder.embed([query]);
  if (!qvec) throw new Error('embedder returned no vector for the query');
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

  let chosen: SkillNote[] | null = null;
  if (embedder && skills.length) {
    // The embedder is optional: an outage, a timeout or an input it refuses
    // must not fail the review, so any error here means area-glob selection.
    try {
      chosen = await selectByEmbedding(store, embedder, skills, touchedFiles, opts.topN ?? 8, opts.minScore ?? 0.2);
    } catch (err) {
      console.warn(`[skills] embedding selection failed (${err instanceof Error ? err.message : String(err)}); using area-glob match`);
    }
  }
  chosen ??= selectByGlob(skills, touchedFiles);

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

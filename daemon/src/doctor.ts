/**
 * Connection check. Pings each configured model endpoint (and the GitHub token)
 * with a tiny request so you can verify a provider — local llama.cpp, Hermes, a
 * hosted GLM, any OpenAI-compatible endpoint — is reachable before running the
 * daemon or a review.
 */
import { generateText, embedMany } from 'ai';
import type { ReviewerConfig, ModelSpec } from '../../agents/common/src/config.js';
import { buildChatModel, buildEmbeddingModel } from '../../agents/common/src/model.js';
import { getOctokit } from '../../agents/common/src/github-auth.js';

export interface ModelProbe {
  readonly roles: string[];
  readonly baseURL: string;
  readonly model: string;
  readonly kind: 'chat' | 'embedding';
  readonly ok: boolean;
  readonly ms: number;
  readonly error?: string;
}

export interface GithubProbe { readonly ok: boolean; readonly login?: string; readonly error?: string; }
export interface DoctorReport { readonly github: GithubProbe; readonly models: ModelProbe[]; }

export async function runDoctor(config: ReviewerConfig): Promise<DoctorReport> {
  // GitHub token
  let github: GithubProbe;
  try {
    const { octokit } = getOctokit(config.github);
    const { data } = await octokit.users.getAuthenticated();
    github = { ok: true, login: data.login };
  } catch (e) {
    github = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // Dedupe roles that share an endpoint+model.
  const entries: Array<{ role: string; spec: ModelSpec; kind: 'chat' | 'embedding' }> = [
    { role: 'review', spec: config.models.review, kind: 'chat' },
    { role: 'curator', spec: config.models.curator, kind: 'chat' },
    { role: 'distill', spec: config.models.distill, kind: 'chat' },
  ];
  if (config.models.embedder) entries.push({ role: 'embedder', spec: config.models.embedder, kind: 'embedding' });

  const groups = new Map<string, { roles: string[]; spec: ModelSpec; kind: 'chat' | 'embedding' }>();
  for (const e of entries) {
    const key = `${e.kind}:${e.spec.baseURL}:${e.spec.model}`;
    const g = groups.get(key);
    if (g) g.roles.push(e.role);
    else groups.set(key, { roles: [e.role], spec: e.spec, kind: e.kind });
  }

  const models: ModelProbe[] = [];
  for (const g of groups.values()) {
    const t = Date.now();
    let ok = false;
    let error: string | undefined;
    try {
      if (g.kind === 'chat') {
        await generateText({ model: buildChatModel(g.spec), prompt: 'ping', maxOutputTokens: 5 });
      } else {
        await embedMany({ model: buildEmbeddingModel(g.spec), values: ['ping'] });
      }
      ok = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    models.push({ roles: g.roles, baseURL: g.spec.baseURL, model: g.spec.model, kind: g.kind, ok, ms: Date.now() - t, error });
  }

  return { github, models };
}

/** true if everything reachable. */
export function doctorOk(r: DoctorReport): boolean {
  return r.github.ok && r.models.every((m) => m.ok);
}

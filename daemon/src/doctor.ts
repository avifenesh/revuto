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
import { openStore } from '../../agents/common/src/store/open.js';

export interface ModelProbe {
  readonly roles: string[];
  readonly baseURL: string;
  readonly model: string;
  readonly api?: string;
  readonly kind: 'chat' | 'embedding';
  readonly ok: boolean;
  readonly ms: number;
  readonly error?: string;
}

export interface GithubProbe { readonly ok: boolean; readonly login?: string; readonly error?: string; }
export interface StoreProbe { readonly backend: string; readonly ok: boolean; readonly ms: number; readonly error?: string; }
export interface DoctorReport { readonly github: GithubProbe; readonly store: StoreProbe; readonly models: ModelProbe[]; }

export async function runModelProbes(config: ReviewerConfig): Promise<ModelProbe[]> {
  // Dedupe roles that share an endpoint+model.
  const entries: Array<{ role: string; spec: ModelSpec; kind: 'chat' | 'embedding' }> = [
    { role: 'review', spec: config.models.review, kind: 'chat' },
    { role: 'curator', spec: config.models.curator, kind: 'chat' },
    { role: 'distill', spec: config.models.distill, kind: 'chat' },
  ];
  if (config.models.embedder) entries.push({ role: 'embedder', spec: config.models.embedder, kind: 'embedding' });

  const groups = new Map<string, { roles: string[]; spec: ModelSpec; kind: 'chat' | 'embedding' }>();
  for (const e of entries) {
    const key = `${e.kind}:${e.spec.api ?? 'chat'}:${e.spec.baseURL}:${e.spec.model}`;
    const g = groups.get(key);
    if (g) g.roles.push(e.role);
    else groups.set(key, { roles: [e.role], spec: e.spec, kind: e.kind });
  }

  const modelProbe = async (g: { roles: string[]; spec: ModelSpec; kind: 'chat' | 'embedding' }): Promise<ModelProbe> => {
    const t = Date.now();
    try {
      if (g.kind === 'chat') await generateText({ model: buildChatModel(g.spec), prompt: 'ping', maxOutputTokens: 16 });
      else await embedMany({ model: buildEmbeddingModel(g.spec), values: ['ping'] });
      return { roles: g.roles, baseURL: g.spec.baseURL, model: g.spec.model, api: g.kind === 'chat' ? g.spec.api ?? 'chat' : undefined, kind: g.kind, ok: true, ms: Date.now() - t };
    } catch (e) {
      return { roles: g.roles, baseURL: g.spec.baseURL, model: g.spec.model, api: g.kind === 'chat' ? g.spec.api ?? 'chat' : undefined, kind: g.kind, ok: false, ms: Date.now() - t, error: e instanceof Error ? e.message : String(e) };
    }
  };

  return Promise.all([...groups.values()].map(modelProbe));
}

export async function runDoctor(config: ReviewerConfig): Promise<DoctorReport> {
  const githubProbe = async (): Promise<GithubProbe> => {
    try {
      const { octokit } = getOctokit(config.github);
      const { data } = await octokit.users.getAuthenticated();
      return { ok: true, login: data.login };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  // Opens the per-repo store + a trivial read.
  const storeProbe = async (): Promise<StoreProbe> => {
    const t = Date.now();
    try {
      const s = await openStore(config, 'revuto/_doctor');
      await s.getCounter('_probe');
      await s.close();
      return { backend: config.store.backend, ok: true, ms: Date.now() - t };
    } catch (e) {
      return { backend: config.store.backend, ok: false, ms: Date.now() - t, error: e instanceof Error ? e.message : String(e) };
    }
  };

  // All probes are independent — run concurrently.
  const [github, store, models] = await Promise.all([
    githubProbe(),
    storeProbe(),
    runModelProbes(config),
  ]);
  return { github, store, models };
}

/** true if everything reachable. */
export function doctorOk(r: DoctorReport): boolean {
  return r.github.ok && r.store.ok && r.models.every((m) => m.ok);
}

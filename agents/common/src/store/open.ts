/**
 * Open the per-repo KnowledgeStore for the configured backend.
 * Skills are Obsidian markdown either way; the backend is the memory layer.
 */
import type { ReviewerConfig } from '../config.js';
import type { KnowledgeStore } from './store.js';
import { SqliteStore } from './sqlite-store.js';
import { SurrealStore } from './surreal-store.js';

export async function openStore(config: ReviewerConfig, repo: string): Promise<KnowledgeStore> {
  if (config.store.backend === 'surreal') {
    const s = new SurrealStore(config.vaultPath, repo, config.store.surreal);
    await s.connect();
    return s;
  }
  return new SqliteStore(config.vaultPath, repo);
}

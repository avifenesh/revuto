/**
 * Re-embed concern records whose embedding has no model tag, with the
 * configured embedder, for every registered repo (or the repos given as args).
 * Works on either store backend. Safe to re-run: tagged records are skipped.
 *
 *   npm run reembed-concerns [-- owner/repo ...]
 */
import { loadConfig } from '../agents/common/src/config.js';
import { maybeEmbedder } from '../agents/common/src/memory/embedder.js';
import { reembedUntaggedConcerns } from '../agents/common/src/memory/reembed.js';
import { openStore } from '../agents/common/src/store/open.js';
import type { KnowledgeStore } from '../agents/common/src/store/store.js';
import { isRepositorySlug, listReviewers } from '../daemon/src/reviewers.js';

const config = loadConfig();
const embedder = maybeEmbedder(config);
if (!embedder) {
  console.error('reembed-concerns: models.embedder is not configured; nothing to embed with');
  process.exit(1);
}

const repos = process.argv.slice(2);
// Stores key on the first two path parts, so `owner/repo/extra` would open and
// rewrite owner/repo. Reject bad args before any store is touched.
const invalid = repos.filter((r) => !isRepositorySlug(r));
if (invalid.length) {
  console.error(`reembed-concerns: not an owner/repo slug: ${invalid.join(', ')}`);
  process.exit(1);
}
const targets = repos.length ? repos : listReviewers(config).map((r) => r.repo);
let failed = false;
for (const repo of targets) {
  let store: KnowledgeStore | undefined;
  try {
    store = await openStore(config, repo);
    const { found, written } = await reembedUntaggedConcerns(store, embedder);
    console.log(`${repo}: ${written}/${found} untagged concerns re-embedded with ${embedder.id}`);
  } catch (err) {
    failed = true;
    console.error(`${repo}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await store?.close();
  }
}
process.exit(failed ? 1 : 0);

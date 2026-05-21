/**
 * Live curator loop pass against the configured provider (no fakes). Feeds one
 * synthetic feedback event through the real runCurator tool loop and reports the
 * model's decision + resulting concerns. Uses a throwaway vault.
 *
 *   set -a; . ~/.hermes/.env; set +a
 *   npx tsx scripts/smoke/live-curator.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../../agents/common/src/config.js';
import { openStore } from '../../agents/common/src/store/open.js';
import { maybeEmbedder } from '../../agents/common/src/memory/embedder.js';
import { runCurator, type FeedbackEvent } from '../../agents/curator/src/run-curator.js';

const config = { ...loadConfig(), vaultPath: mkdtempSync(join(tmpdir(), 'reviewer-live-')) };
const store = await openStore(config, 'octo/demo');
const embedder = maybeEmbedder(config);

const feedback: FeedbackEvent = {
  feedbackId: 'rc-live-1',
  kind: 'review_comment_reply',
  body: 'Agree — this reconnect loop has no backoff cap, it has bitten us before. Please bound the retries.',
  botComment: { body: 'This reconnect path retries unconditionally; is the retry count bounded?', path: 'src/net/reconnect.c', line: 42, prNumber: 1, repo: 'octo/demo' },
  actor: 'maintainer',
  touchedFiles: ['src/net/reconnect.c'],
};

console.log(`live curator pass via ${config.models.curator.model} @ ${config.models.curator.baseURL}`);
const t = Date.now();
const out = await runCurator({ config, store, embedder, feedback });
console.log(`decision=${out.decision} | summary=${out.summary} | ${Date.now() - t}ms`);
console.log('concerns:', JSON.stringify((await store.allConcerns()).map((c) => ({ bucket: c.areaBucket, subject: c.subject, area: c.area, count: c.reinforcementCount })), null, 2));
await store.close();

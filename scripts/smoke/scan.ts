/**
 * Deterministic Phase 4 smoke: the onboarding repo-scan (no GitHub/LLM).
 * Runs scanRepo against this engine repo and checks the extracted facts.
 *
 *   npx tsx scripts/smoke/scan.ts
 */
import assert from 'node:assert/strict';
import { scanRepo } from '../../daemon/src/init.js';
import { engineRoot } from '../../agents/common/src/engine-root.js';

const facts = scanRepo(engineRoot());

assert.ok(facts.topDirs.includes('agents'), 'finds agents/');
assert.ok(facts.topDirs.includes('daemon'), 'finds daemon/');
assert.ok(!facts.topDirs.includes('node_modules'), 'skips node_modules');
assert.ok(facts.languages.some((l) => l.ext === '.ts' && l.count > 0), 'counts .ts files');
assert.ok(facts.buildFiles.includes('package.json'), 'detects package.json build file');
assert.ok(facts.readmeExcerpt.length > 0, 'reads README excerpt');

console.log(`PASS: repo scan — topDirs=[${facts.topDirs.join(',')}] langs=${facts.languages.slice(0, 4).map((l) => `${l.ext}:${l.count}`).join(' ')} build=[${facts.buildFiles.join(',')}]`);

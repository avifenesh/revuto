/** Rebuild the Obsidian reviewers index from the registered reviewer notes. */
import { loadConfig } from '../agents/common/src/config.js';
import { updateIndex } from '../daemon/src/reviewers.js';

updateIndex(loadConfig());
console.log('reviewers/_index.md written');

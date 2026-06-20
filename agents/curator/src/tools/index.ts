import { buildConcernsStoreTools, type ConcernsStoreDeps } from './concerns-store.js';
import { buildSubmitSkillTool, buildListSkillsTool } from './submit-skill.js';
import { buildSkillAuthoringTool } from './skill-authoring.js';
import { buildCuratorDoneTool } from './done.js';
import type { ToolDef } from '../../../common/src/tool-def.js';

/**
 * Curator tool surface (local, vault-graduated form):
 *   - 6 concerns-store CRUD tools (per-repo SQLite, optional embedding on create)
 *   - list_skills            — Phase 2: see accumulated topic skills (create-vs-revise)
 *   - search_skill_authoring — Phase 2: pull the skill-writing guidance
 *   - submit_skill           — graduate to a skill note in the vault
 *   - curator_done           — terminal signal
 */
export function assembleCuratorTools(deps: ConcernsStoreDeps & { autoActivate?: boolean }): readonly ToolDef[] {
  return [
    ...buildConcernsStoreTools(deps),
    buildListSkillsTool(deps.store),
    buildSkillAuthoringTool(),
    buildSubmitSkillTool(deps.store, { autoActivate: deps.autoActivate }),
    buildCuratorDoneTool(),
  ];
}

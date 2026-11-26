import type { SkillScope } from './hub';

/**
 * Where a new skill lives. Workspace skills page (no target) → the workspace.
 * Agent/channel page → that target if "Attach immediately" stays checked; unchecked → personal,
 * unless "Also apply to entire workspace" is checked.
 */
export function newSkillScope(ws: string, targetScope: SkillScope | '', targetId: string, attachWorkspace: boolean): { scope: SkillScope; id: string } | undefined {
  if (targetScope && targetId) return { scope: targetScope, id: targetId };
  if (!targetId || attachWorkspace) return { scope: 'workspace', id: ws };
  return undefined;
}

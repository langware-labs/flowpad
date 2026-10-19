import { Project, TypeId } from '@sdk';

/**
 * The attachment key (`AgenticProcess.target_typeid_str`) every project chat is
 * created with, in EVERY mode — `openNewChat` (Standard/Advanced) and
 * `createVibeProcessForProject` (Vibe) both stamp this one value.
 *
 * It lives here, above both, because it is the contract between them: the
 * consumers that read it — Vibe's "Past builds" list (`useProcessesForTarget`)
 * and the rail's last-chat resolver — must key on the same string whichever
 * path minted the session, or a chat becomes invisible to them purely because
 * of the mode it was started in.
 */
export function chatTargetForProject(projectId: string): string {
  return new TypeId(Project.type, projectId).toString();
}

import { Agent, Project, type ProjectHomePage } from '@sdk';
import { lazyAssets, LazyAsset } from '@sdk/lazy';
import {
  canonicalPath,
  cloneGitProject,
  selectProjectContext,
} from '@src/components/project-selector/use-ensure-project';
import { DockPointer } from '@src/navigation/DockPointer';
import { homePageDock } from '@src/project-home-page/project-home-page-redirect';
import type { LaunchPlan } from './launch-plan';

/** The SETUP stage's steps, in order — what the launch dialog lists. */
export type LaunchStep = 'controller' | 'target' | 'setup' | 'session';

export interface LaunchRun {
  /** The compute node a `?repo=` target is cloned on. */
  computeNodeId: string | null;
  /** The workspace a `?repo=` target is cloned into (undefined → the default one). */
  workspaceId?: string;
  onStep?: (step: LaunchStep) => void;
}

/**
 * A repository target (a `?repo=` link): cloned into a fresh project — or, when a folder of
 * that name is already there, the project already at it, so a second click opens the same one.
 */
async function projectForRepo(repo: string, branch: string | undefined, run: LaunchRun): Promise<Project> {
  if (!run.computeNodeId) throw new Error('No compute node to clone the repository on.');
  const result = await cloneGitProject(run.computeNodeId, repo, { branch, workspaceId: run.workspaceId });
  if (result.kind === 'ok') return result.project;
  if (result.kind === 'collision') {
    const leaf = canonicalPath(result.attemptedName).split('/').pop();
    const existing = (await lazyAssets.refresh(LazyAsset.Projects)).find(
      (p) => canonicalPath(p.fs_storage_mount_path ?? '').split('/').pop() === leaf,
    );
    if (existing) return existing;
  }
  throw new Error(result.kind === 'error' ? result.message : `A folder named ${result.attemptedName} is in the way.`);
}

/** The face: the link's agent, else the controller's home page, else the target's. */
async function launchFace(plan: LaunchPlan, controller: Project | null, target: Project): Promise<ProjectHomePage> {
  if (plan.agentId) return { asset: `${Agent.type}-${plan.agentId}`, type: Agent.type };
  if (controller) {
    const home = await Project.openHomePage(controller.id);
    if (home.asset) return home;
  }
  return Project.openHomePage(target.id);
}

/**
 * SETUP: from "agent + deployed git" to the session running — the one handler both launch
 * legs land on (`action=launch`), so the desktop and a cloud box set up the same way.
 *
 * 1. Both projects present and checked out HERE (`launchEnsure`: mirrored from the hub,
 *    materialized in place; a no-op where the hub already provisioned them). The controller
 *    is checked out BESIDE the target, never attached to it — nothing is written to the
 *    target's `flow.json`.
 * 2. Set up by subkind: a controller's own requirements are started (its questions come to
 *    this app); the target is the controller's to deal with, so it is not set up here.
 * 3. The face opens IN the target: `Agent.use(project_id=target)` — the session's working
 *    directory is the target, the controller's folder is mounted as the agent's home.
 *
 * Returns where to land; the caller navigates (URL-first).
 */
export async function runLaunch(plan: LaunchPlan, run: LaunchRun): Promise<DockPointer> {
  // The two projects are independent until the session: fetch them side by side.
  run.onStep?.('controller');
  const [controller, target] = await Promise.all([
    plan.controllerId ? Project.launchEnsure(plan.controllerId) : null,
    'projectId' in plan.target
      ? Project.launchEnsure(plan.target.projectId)
      : projectForRepo(plan.target.repo, plan.target.branch, run),
  ]);
  run.onStep?.('target');

  if (controller) {
    run.onStep?.('setup');
    const readiness = await Project.setupRequirements(controller.id);
    if (readiness && !readiness.ready) await Project.startSetup(controller.id);
  }

  run.onStep?.('session');
  const [face] = await Promise.all([launchFace(plan, controller, target), selectProjectContext(target)]);
  return (await homePageDock(face, target.id)) ?? DockPointer.forProject(target.id);
}

import { t } from '@lingui/core/macro';
import { Agent, Project, type ProjectHomePage, TypeId } from '@sdk';
import { lazyAssets, LazyAsset } from '@sdk/lazy';
import {
  canonicalPath,
  cloneGitProject,
  selectProjectContext,
} from '@src/components/project-selector/use-ensure-project';
import { startAgentSession } from '@src/components/agents/use-agent-launcher';
import { ViewMode } from '@src/contexts/view-mode-context';
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
  /** A controller that cannot run here yet: its setup is the caller's to put on screen. */
  onNeedsSetup?: (controller: Project) => void;
}

/** A launch that stopped, and the step it stopped at — so the list blames the right row. */
export class LaunchFailure extends Error {
  constructor(
    readonly step: LaunchStep,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/** `work`, failing as `step`. */
async function during<T>(step: LaunchStep, work: Promise<T> | T): Promise<T> {
  try {
    return await work;
  } catch (e) {
    throw new LaunchFailure(step, e);
  }
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
      (p) =>
        canonicalPath(p.fs_storage_mount_path ?? '')
          .split('/')
          .pop() === leaf,
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
 * 2. Set up by subkind: a controller that is not ready has its setup put on screen by the
 *    caller (`onNeedsSetup`); the target is the controller's to deal with, so it is not set up here.
 * 3. The face opens IN the target, in a NEW session: `Agent.use(project_id=target)` — the
 *    session's working directory is the target, the controller's folder is mounted as the
 *    agent's home. Clicking the link again runs again; it does not resume the last chat.
 *
 * Returns where to land; the caller navigates (URL-first).
 */
export async function runLaunch(plan: LaunchPlan, run: LaunchRun): Promise<DockPointer> {
  // One after the other, never side by side: each fetch writes this machine's project rows and
  // indexes a checkout, and two at once fought each other — and a new install's own startup work —
  // for the local database ("database is locked" on a first-time desktop).
  let controller: Project | null = null;
  if (plan.controllerId) {
    run.onStep?.('controller');
    controller = await during('controller', Project.launchEnsure(plan.controllerId));
  }
  run.onStep?.('target');
  const target = await during(
    'target',
    'projectId' in plan.target
      ? Project.launchEnsure(plan.target.projectId)
      : projectForRepo(plan.target.repo, plan.target.branch, run),
  );

  if (controller) {
    run.onStep?.('setup');
    const readiness = await during('setup', Project.setupRequirements(controller.id));
    if (readiness && !readiness.ready) run.onNeedsSetup?.(controller);
  }

  run.onStep?.('session');
  const [face] = await during(
    'session',
    Promise.all([launchFace(plan, controller, target), selectProjectContext(target)]),
  );
  if (face.asset && face.type === Agent.type) {
    // A launch was asked to run: a NEW session, where Home would resume the agent's last chat.
    const agent = await during('session', Agent.getById<Agent>(new TypeId(face.asset).id));
    if (!agent)
      throw new LaunchFailure('session', new Error(t`The agent this link names isn't in the project's files.`));
    return DockPointer.forSession(await during('session', startAgentSession(agent, target.id))).withViewMode(
      ViewMode.Vibe,
    );
  }
  return (await homePageDock(face, target.id)) ?? DockPointer.forProject(target.id);
}

import { Agent, AgenticProcess, dataContext, isHubOnly, Project, TypeId, type ProjectHomePage } from '@sdk';
import { replace } from 'react-router';

import { DockPointer } from '@src/navigation/DockPointer';
import { dockForDisplayTarget } from '@src/navigation/display-target-pointer';
import { ViewMode } from '@src/contexts/view-mode-context';
import { ambientLoadProjectId, registerLoadRedirect } from '@src/routes/loaders/load-redirects';
import { prepareAgentSession } from '@src/components/agents/use-agent-launcher';
import { lastVibeChatQuery, pickLastVibeChat } from '@src/pages/flow-page/vibe-process-resolver';
import { HOME_PAGE_OPEN, HOME_PAGE_PARAM, rememberProjectHomePage } from './home-page-state';

/** Registration IS the switch: `false` takes the resolver out of the chain entirely. */
export const PROJECT_HOME_PAGE_ENABLED = true;

/**
 * Where an AGENT home page lands: its last chat in this project — the rail's
 * Chats-icon query narrowed to the agent (`lastVibeChatQuery`) — else a new
 * session, opened with the same pre-turn stack `useAgentLauncher` gives one.
 * Resuming is the point: Home is clicked again and again, and minting a
 * session per click would leave an empty conversation behind each time.
 */
async function agentHomePageDock(agentTypeId: string, projectId: string): Promise<DockPointer | null> {
  const last = pickLastVibeChat(
    await AgenticProcess.query<AgenticProcess>(lastVibeChatQuery(projectId, agentTypeId)),
  );
  let processId = last?.id ?? null;
  if (!processId) {
    const agent = await Agent.getById<Agent>(new TypeId(agentTypeId).id);
    if (!agent) return null;
    processId = (await agent.use(projectId)).process_id;
    await prepareAgentSession(processId).catch((e) =>
      console.warn('[project-home-page] pre-turn setup failed; opening the session anyway', e),
    );
  }
  return DockPointer.forShell(`${AgenticProcess.type}-${processId}`).withViewMode(ViewMode.Vibe);
}

/**
 * Where a resolved home page lives: an agent's chat in Vibe, else the asset's
 * own view — the same routing `flow show entity` uses. Null when the asset
 * addresses nothing openable.
 */
export async function homePageDock(data: ProjectHomePage, projectId: string): Promise<DockPointer | null> {
  if (!data.asset || !data.type) return null;
  if (data.type === Agent.type) return agentHomePageDock(data.asset, projectId);
  return dockForDisplayTarget({ kind: 'entity', typeid: data.asset, type: data.type });
}

/**
 * The project home page redirect, or null when there is nothing to land on.
 *
 * Acts only on a load that ASKS for it — `?homePage=open` (`withHomePage`),
 * on the root or on the project's dock — and every time it is asked, not only
 * the first. Two kinds of navigation ask:
 *  - LAUNCHING a project: opening a folder or clone, picking a project,
 *    setting up a shared one, switching to one.
 *  - The Home button (`goHome({ homePage: true })`).
 * Everything else that lands on the project page — its own "Open project home"
 * button, its tab, the fallback after closing a tab — does not ask, so the
 * project page (where the home page is configured) stays reachable. Safe to
 * repeat because an agent home page RESUMES its last chat rather than minting
 * one per visit.
 *
 * Same contract as the other load redirects: never blocks the load (any
 * failure means the default home) and lands as real URL state. `replace`, not
 * `redirect`: the `?homePage=open` location must not stay behind the session,
 * or Back would re-run this loader and bounce straight forward again.
 */
export async function projectHomePageRedirect(request: Request): Promise<Response | null> {
  if (isHubOnly()) return null;
  if (new URL(request.url).searchParams.get(HOME_PAGE_PARAM) !== HOME_PAGE_OPEN) return null;
  const scoped = ambientLoadProjectId(request);
  if (scoped === undefined) return null; // deep link / Hub / inside a session
  const projectId = scoped ?? dataContext.project?.id ?? null;
  if (!projectId) return null;

  let data: ProjectHomePage;
  try {
    data = await Project.openHomePage(projectId);
  } catch (e) {
    console.warn('[project-home-page] backend call failed; default home', e);
    return null;
  }
  if (data?.error) {
    console.warn('[project-home-page] backend could not open the home page', data.error);
    return null;
  }
  let dock: DockPointer | null;
  try {
    dock = data ? await homePageDock(data, projectId) : null;
  } catch (e) {
    console.warn('[project-home-page] could not open the home page; default home', e);
    return null;
  }
  if (!dock) return null;

  rememberProjectHomePage(projectId, dock);
  return replace(dock.toUrl());
}

// Imported by the home loader; the resolver list is shared, so it runs on root
// loads and on project-dock loads alike. After agent auto-launch on purpose:
// first redirect wins, so an agent's once-only auto-launch takes the very first
// open.
if (PROJECT_HOME_PAGE_ENABLED) registerLoadRedirect(projectHomePageRedirect);

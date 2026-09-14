/**
 * Adopting a signed-in session without reloading the page.
 *
 * `initSdk` is memoised and runs once per page load, so a page that bootstrapped
 * ANONYMOUSLY — the hub `/launch` landing, whose whole point is to be opened by a
 * stranger — used to learn about a later sign-in only by reloading. Most of what
 * initSdk set up does not care who the user is (the type registry, icon packs,
 * locales), and the transports adopt the new session by themselves: `apiClient`
 * sends the session cookie (`withCredentials`), and the WebSocket reconnects on
 * every close and the hub reads its token from that same cookie. What is left is
 * the handful of user-dependent context entries, which is what this module owns.
 *
 * `applyBootstrapUser` is THE one place those entries are applied — `initSdk`
 * calls it on first load and `refreshSession` calls it after a sign-in — so the
 * two paths cannot drift into disagreeing about what "signed in" sets up.
 */
import { dataManager } from './APIEntity';
import { authManager, dataContext } from './FlowSync';
import { ContextEntitiesEnum } from './FlowSync/context';
import { capabilityManager } from './capabilities';
import { User, Workspace } from './entities';
import type { BootstrapInfo } from './models/BootstrapInfo';
import { cloudManager } from './services/cloud_login';

/** Apply the user-dependent part of a bootstrap payload to the SDK context. */
export async function applyBootstrapUser(info: BootstrapInfo): Promise<User | null> {
  // User FIRST (before workspace), so the user is set when anything reacting to
  // the workspace change reads it.
  let user: User | null = null;
  if (info.user) {
    user = new User(info.user);
    user.markAsExpanded();
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.LocalUserTypeId, user.typeId);
  }

  // Default workspace, after the user is set.
  if (info.default_workspace) {
    const workspace = new Workspace(info.default_workspace);
    workspace.markAsExpanded();
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentWorkspaceTypeId, workspace.typeId);
  }
  await authManager.init(user);
  capabilityManager.setSummary(info.capabilities_summary);
  return user;
}

/**
 * Re-read the bootstrap now that the browser holds a session, and adopt it in
 * place. Resolves true once the page is signed in, false when it could not be —
 * the caller's cue to fall back to a reload, which is the known-good path.
 *
 * One bootstrap call, the same one a reload would make — so the hub-side work
 * that bootstrap does for a signed-in caller (`ensure_user_default`, which mints
 * the user's LLM budget) still happens.
 *
 * Opt-in (`cloudManager.login({ refresh: 'session' })`), not the default: views
 * that loaded their DATA anonymously are only correct after this if they re-query
 * when the user changes, and that has been checked for the `/launch` landing
 * alone.
 */
export async function refreshSession(): Promise<boolean> {
  try {
    const domain = window.location.hostname;
    const session = !(window as { allow_persistent_visitor?: boolean }).allow_persistent_visitor;
    const fresh = await dataManager.bootstrap(domain, session);
    if (!fresh?.user) return false;

    // Carry the RUNTIME over from the current payload: whether this app is the hub
    // is not something a sign-in can change, and the current one already had the
    // `VITE_FORCE_HUB` dev override applied by initSdk.
    const current = dataContext.bootstrapInfo as
      | (BootstrapInfo & { supported_pages?: string[] })
      | null
      | undefined;
    const merged = {
      ...fresh,
      supported_pages: current?.supported_pages ?? (fresh as { supported_pages?: string[] }).supported_pages,
      runtime: current?.runtime ?? fresh.runtime,
    } as BootstrapInfo;

    // Replaced BEFORE the context entities change, because the same `user` field
    // is what `main-loader` reads to decide whether a dock load is signed in:
    // left anonymous, the user's next in-app navigation would bounce to login.
    dataContext.bootstrapInfo = merged;
    await applyBootstrapUser(merged);
    // The anonymous visitor is the hub's to migrate (bootstrap did, server-side,
    // just now); the client just stops pointing at it.
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentVisitorTypeId, null);
    await cloudManager.adoptSignedInUser(fresh.user as unknown as Record<string, unknown>);
    return true;
  } catch (e) {
    console.warn('[refreshSession] could not adopt the new session; caller will reload', e);
    return false;
  }
}

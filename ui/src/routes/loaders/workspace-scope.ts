import { dataContext, type IWorkspace, type Project, resolveActiveWorkspace } from '@sdk';
import { lazyAssets, LazyAsset } from '@sdk/lazy';
import { type DockPointer, WORKSPACE_PARAM } from '@src/navigation/DockPointer';

/**
 * Loader-side view of the active workspace (`?workspace=<id>`, absent = default) — the
 * same `resolveActiveWorkspace` rule `useActiveWorkspace` applies.
 *
 * Asks the backend for nothing: the workspace list comes from the lazy cache when a
 * surface already loaded it (it is live — entity ops refresh it), else from the
 * bootstrap payload. A loader must stay fast, and a warm visit makes no request.
 */
function knownWorkspaces(): IWorkspace[] {
  const cached = lazyAssets.client.getQueryData<IWorkspace[]>(lazyAssets.key(LazyAsset.Workspaces));
  return cached ?? dataContext.bootstrapInfo?.workspaces ?? [];
}

/** A predicate "this project belongs to the URL's workspace", or null while only the
 *  default workspace exists — then nothing is filtered, as before workspaces. */
export function projectInDockWorkspace(dock: DockPointer): ((project: Project) => boolean) | null {
  const { hasMany, workspace, contains } = resolveActiveWorkspace(knownWorkspaces(), dock.options?.[WORKSPACE_PARAM]);
  if (!hasMany || !workspace) return null;
  return (project) => contains(project.fs_storage_mount_path);
}

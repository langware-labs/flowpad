import { resolveActiveWorkspace, type ResolvedWorkspace, type Workspace, workspaceDisplayName } from '@sdk';
import { useAuth } from '@sdk/react/hooks/useAuth';
import { useLazyAsset } from '@sdk/react/hooks/useLazyAsset';
import { LazyAsset } from '@sdk/lazy';
import { useMemo } from 'react';
import { useContext } from '@src/hooks/useContext';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { WORKSPACE_PARAM } from '@src/navigation/DockPointer';

const NO_WORKSPACES: Workspace[] = [];

export interface ActiveWorkspace extends ResolvedWorkspace<Workspace> {
  /** Every workspace on this instance, the default one first, then by name. */
  workspaces: Workspace[];
  /** The active workspace's folder, VFS-relative like bootstrap `paths.workspace` — where
   *  new projects go. `''` until anything is known. */
  root: string;
  reload: () => Promise<unknown>;
}

/**
 * The active workspace — derived from the URL (`?workspace=<id>`, absent = default),
 * never from context, per URL-first navigation; `resolveActiveWorkspace` is the rule,
 * shared with the loaders. Switch with `navigation.openWorkspace()`.
 */
export function useActiveWorkspace(): ActiveWorkspace {
  const { user } = useAuth();
  const { desktopInfo } = useContext();
  const urlId = useDockNavigation().currentDock?.options?.[WORKSPACE_PARAM] ?? null;
  const result = useLazyAsset(LazyAsset.Workspaces, undefined, { enabled: !!user });
  const rows = result.data ?? NO_WORKSPACES;
  const reload = result.reload;
  const fallbackRoot = desktopInfo?.paths?.workspace ?? '';

  return useMemo(() => {
    const workspaces = rows
      .slice()
      .sort((a, b) => Number(!!b.is_default) - Number(!!a.is_default) || workspaceDisplayName(a).localeCompare(workspaceDisplayName(b)));
    const resolved = resolveActiveWorkspace(workspaces, urlId);
    return { ...resolved, workspaces, root: resolved.workspace?.root || fallbackRoot, reload };
  }, [rows, urlId, fallbackRoot, reload]);
}

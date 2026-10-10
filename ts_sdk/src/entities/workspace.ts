import { APIEntity, registerEntity } from '../APIEntity';
import { EntityTypes } from '../schema/types';
import { EntityMerge } from '../IEntity';
import { IWorkspace } from './workspace-types';
export type * from './workspace-types';

// `implements IWorkspace` only checks the class; it contributes no members, so every
// field declared solely on IWorkspace read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Workspace extends EntityMerge<IWorkspace> {}

@registerEntity
export class Workspace extends APIEntity<Workspace> implements IWorkspace {
  static type: string = EntityTypes.Workspace;
  name?: string;
  namespace?: string;
  root_path?: string | null;
  root?: string;
  is_default?: boolean;

  constructor(entity: Partial<IWorkspace> = {}) {
    super(entity);
    this.name = entity.name;
    this.namespace = entity.namespace;
    this.root_path = entity.root_path;
    this.root = entity.root;
    this.is_default = entity.is_default;
  }
}

/** What the default workspace is called wherever it is shown. */
export const DEFAULT_WORKSPACE_NAME = 'Flowpad';

export function workspaceDisplayName(workspace: Pick<IWorkspace, 'name' | 'is_default'> | null | undefined): string {
  if (!workspace || workspace.is_default) return DEFAULT_WORKSPACE_NAME;
  return workspace.name || DEFAULT_WORKSPACE_NAME;
}

/** A Windows drive (`C:/…`) or UNC (`//host/…`) path: NTFS compares case-insensitively. */
function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:\//.test(path) || path.startsWith('//');
}

function normalize(path: string): string {
  const posix = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return isWindowsPath(posix) ? posix.toLowerCase() : posix;
}

/** Segment-safe containment of canonical absolute paths — `/a/bc` is NOT under `/a/b`.
 *  The frontend twin of `flow_sdk.fs_store.path_utils.is_path_under`. */
export function isPathUnderRoot(path: string, root: string): boolean {
  const p = normalize(path);
  const r = normalize(root);
  if (!p || !r) return false;
  return p === r || p.startsWith(`${r}/`);
}

/**
 * The workspace a folder belongs to: the user-created one whose `root_path` contains it,
 * else the default one. The frontend twin of `flow_sdk.config.workspace_id_for_path` —
 * membership is a location fact, so with no user-created workspace every path is the
 * default workspace's.
 */
export function workspaceForPath<W extends Pick<IWorkspace, 'is_default' | 'root_path'>>(
  path: string | null | undefined,
  workspaces: readonly W[],
): W | undefined {
  const fallback = workspaces.find((w) => w.is_default);
  if (!path) return fallback;
  return workspaces.find((w) => !w.is_default && w.root_path && isPathUnderRoot(path, w.root_path)) ?? fallback;
}

export interface ResolvedWorkspace<W> {
  /** The active workspace's row (the default one for no / an unknown / the default id). */
  workspace: W | undefined;
  /** More than the default workspace exists. */
  hasMany: boolean;
  /** The id a workspace-scoped request sends — undefined while only the default
   *  workspace exists, so every request is the one from before workspaces. */
  scopeId: string | undefined;
  /** Does a folder belong to the active workspace? Always true while only the default exists. */
  contains: (path: string | null | undefined) => boolean;
}

/**
 * The active workspace for a URL's `?workspace=` id — the one rule the UI's hook and
 * its loaders share. An id that names no user-created workspace (absent, deleted, the
 * default's own) is the default workspace. Roots are normalized once, here, so
 * `contains` stays cheap when a list is filtered with it.
 */
export function resolveActiveWorkspace<W extends Pick<IWorkspace, 'id' | 'is_default' | 'root_path'>>(
  workspaces: readonly W[],
  urlId: string | null | undefined,
): ResolvedWorkspace<W> {
  const defaultWorkspace = workspaces.find((w) => w.is_default);
  const workspace = (urlId ? workspaces.find((w) => w.id === urlId && !w.is_default) : undefined) ?? defaultWorkspace;
  const roots = workspaces
    .filter((w) => !w.is_default && w.root_path)
    .map((w) => ({ id: w.id, root: normalize(w.root_path as string) }));
  const hasMany = roots.length > 0;
  const contains = (path: string | null | undefined) => {
    if (!hasMany || !workspace) return true;
    const p = path ? normalize(path) : '';
    const owner = p ? roots.find(({ root }) => p === root || p.startsWith(`${root}/`)) : undefined;
    return (owner?.id ?? defaultWorkspace?.id) === workspace.id;
  };
  return { workspace, hasMany, scopeId: hasMany ? workspace?.id : undefined, contains };
}

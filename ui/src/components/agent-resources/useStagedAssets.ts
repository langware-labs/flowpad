import { useMemo } from 'react';
import { dataContext } from '@sdk';
import type { AssetDescriptor } from '@sdk';
import { useProcessAssets, type UseProcessAssetsResult } from '@src/components/asset-manager';

/** The folder every repo asset mounts under: `<container>/agentic-assets/<family>/<name>`. */
const AGENTIC_ASSETS_DIR = 'agentic-assets';

/**
 * True when this asset lives INSIDE another asset — i.e. it is some agent's own
 * private copy, not a thing you could attach.
 *
 * `Agent.add_mcp` deliberately materializes a self-contained copy of an Mcp
 * under the owning agent's folder so a shared agent carries its servers with it.
 * The staging scan walks the project tree and finds those copies too, so one
 * logical server was offered three times over: once for real, once per agent
 * that had attached it.
 *
 * The test is the path shape, because at this layer the path is ALL there is:
 * these rows come from `disk_asset_descriptors`, the filesystem half of the
 * staging scan, which lists assets that have no entity row yet — so there is no
 * `parent_type_id` to read (that is what the `/search` side filters on). A
 * container that is itself an asset puts the segment in the path twice, which is
 * the same structural rule the backend `repo_assets_fn` walker recurses on.
 */
export function isNestedAssetPath(posixPath: string | null | undefined): boolean {
  if (!posixPath) return false;
  const depth = posixPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment === AGENTIC_ASSETS_DIR).length;
  return depth > 1;
}

/**
 * Assets of one type that a process started in this project would see, via the
 * staging read `useProcessAssets(null, …)` — rows arrive already attributed to
 * a `source`. NOT a type listing: `/graph/<type>` has no location filter and
 * returns everything indexed on the machine (77 skills here, 10 of them real).
 *
 * Agent-owned copies are dropped (see `isNestedAssetPath`): this list answers
 * "what could I attach here?", and another agent's private copy is never that
 * answer — the canonical asset it was copied from is already in the list.
 * Filtered here rather than in `useProcessAssets` so the LIVE-process read
 * ("what does this process actually see?") keeps reporting its own copies.
 */
export function useStagedAssets(type: string): UseProcessAssetsResult {
  // The pane rides the active project; `useProcessAssets` falls back to
  // `@local` on its own when there is none, so this stays undefined rather
  // than guessing an id here.
  const projectId = dataContext.project?.typeId?.id;

  // Keyed on the type STRING, not an array literal, so the fetch is rebuilt
  // only when the caller actually asks for a different type.
  const options = useMemo(() => ({ projectId, types: [type] }), [projectId, type]);

  // Destructured, NOT kept as one object: `useProcessAssets` returns a fresh
  // literal every render, so memoizing on it would hand back a new descriptors
  // array each time — and `AgentMcpField` derives `agent.md`'s `mcp_servers`
  // from this list, so churn there is a re-commit, not just a re-render.
  const { descriptors, isLoading, refresh } = useProcessAssets(null, options);

  const attachable = useMemo(
    () => descriptors.filter((d: AssetDescriptor) => !isNestedAssetPath(d.posix_path)),
    [descriptors],
  );

  return useMemo(
    () => ({ descriptors: attachable, isLoading, refresh }),
    [attachable, isLoading, refresh],
  );
}

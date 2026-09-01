import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Agent, FSRef, TypeId, VFSPath } from '@sdk';
import { useEntityOps } from '@sdk/react/hooks';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { AssetRoutingMethod } from '@src/navigation/asset-doc-types';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useEntity } from '@src/hooks/entity-hooks';
import { ViewType } from '@src/types/ViewType';

/** Module-scope: `useEntityOps` keys its effect on the array's IDENTITY. */
const WATCHED_TYPES = ['agent'];



/** The `worker_type:` scalar, without pulling a YAML parser in for one key. */
function readWorkerType(source: string): string {
  const fence = source.indexOf('\n---', 4);
  const yaml = source.startsWith('---') && fence > 0 ? source.slice(4, fence) : '';
  const line = yaml.split('\n').find((l) => /^worker_type\s*:/.test(l));
  return line ? line.split(':').slice(1).join(':').trim().replace(/^['"]|['"]$/g, '') : '';
}

/**
 * The worker the edited agent is set to, read straight off `agent.md`. Resolved
 * from the URL because the navigator is a SIBLING of the profile editor, so no
 * React context reaches it. Refetches on agent ops, which is how a worker change
 * in the editor reaches this pane.
 */
export function useEditedAgentWorker(): { workerType: string; isLoading: boolean } {
  const { currentDock } = useDockNavigation();
  const queryClient = useQueryClient();

  // A project-shell asset URL carries the asset pointer one level in.
  const effectivePointer =
    currentDock?.viewType === ViewType.PROJECT
      ? DockPointer.splitProjectPointer(currentDock?.pointer).assetSubPointer
      : (currentDock?.pointer ?? '');

  const ptr = useMemo(() => {
    try {
      return AssetDocPointer.parse(effectivePointer);
    } catch {
      return null;
    }
  }, [effectivePointer]);

  // vfs: the pointer NAMES the agent's own file, so it IS the main ref.
  // Memoized on the stable pointer string — a fresh FSRef per render churns
  // every query keyed on it (this pane has been frozen once by exactly that).
  const vfsRef = useMemo(() => {
    if (ptr?.method !== AssetRoutingMethod.VFS) return null;
    const vfs = VFSPath.parse(ptr.value);
    return vfs.typeId ? new FSRef(vfs.entitySubPath, vfs.typeId) : null;
  }, [ptr]);

  // typeid: the record carries both the path and the filesystem authority.
  const typeId = useMemo(
    () => (ptr?.method === AssetRoutingMethod.TYPEID ? new TypeId(ptr.value) : null),
    [ptr],
  );
  const { data: agent } = useEntity<Agent>(typeId);
  const { data: record } = useQuery({
    queryKey: ['agent-resources', 'record', typeId?.toString() ?? ''],
    queryFn: () => agent!.record(),
    enabled: !!agent && ptr?.method === AssetRoutingMethod.TYPEID,
    staleTime: Infinity,
  });

  const mainRef: FSRef | null = ptr?.method === AssetRoutingMethod.VFS ? vfsRef : (record?.mainRef ?? null);
  const path = mainRef?.path ?? '';

  const docKey = useMemo(() => ['agent-resources', 'doc', path] as const, [path]);
  const { data: source, isLoading } = useQuery({
    queryKey: docKey,
    queryFn: () => mainRef!.read(),
    enabled: !!mainRef,
  });

  const onAgentOp = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['agent-resources', 'doc'] });
  }, [queryClient]);
  useEntityOps(WATCHED_TYPES, onAgentOp as never);

  return { workerType: source ? readWorkerType(source) : '', isLoading: !!mainRef && isLoading };
}

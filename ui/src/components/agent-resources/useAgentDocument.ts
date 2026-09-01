import { useCallback, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Agent, FSRef, TypeId, VFSPath } from '@sdk';
import { useEntityOps } from '@sdk/react/hooks';
import {
  patchAgentDocument,
  readAgentDocumentList,
  type AgentDocumentListKey,
  type AgentDocumentPatch,
} from '@src/components/assets/editor/agent-profile/agent-document';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { AssetRoutingMethod } from '@src/navigation/asset-doc-types';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useEntity } from '@src/hooks/entity-hooks';
import { ViewType } from '@src/types/ViewType';

/** Module-scope: `useEntityOps` keys its effect on the array's IDENTITY. */
const WATCHED_TYPES = ['agent'];

export interface AgentDocument {
  /** True once the document is readable, i.e. edits can be committed. */
  ready: boolean;
  isLoading: boolean;
  /** `worker_type:` — drives which MCP servers and skills apply. */
  workerType: string;
  /** Read one frontmatter list (e.g. the declared `skills`). */
  list: (key: AgentDocumentListKey) => string[];
  /** Losslessly commit a frontmatter patch. Serialized against itself. */
  commit: (patch: AgentDocumentPatch) => Promise<void>;
}

/** The `worker_type:` scalar, without pulling a YAML parser in for one key. */
function readWorkerType(source: string): string {
  const fence = source.indexOf('\n---', 4);
  const yaml = source.startsWith('---') && fence > 0 ? source.slice(4, fence) : '';
  const line = yaml.split('\n').find((l) => /^worker_type\s*:/.test(l));
  return line ? line.split(':').slice(1).join(':').trim().replace(/^['"]|['"]$/g, '') : '';
}

/**
 * `agent.md` as the pane's read/write surface — the file is the record, so edits
 * stay lossless and work unindexed. The `typeid` route still resolves the entity
 * (only its record says where the main file lives). Refetches on agent ops.
 */
export function useAgentDocument(): AgentDocument {
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

  const list = useCallback(
    (key: AgentDocumentListKey) => (source ? readAgentDocumentList(source, key) : []),
    [source],
  );

  // Chained, not concurrent: two toggles in quick succession must not both
  // read the same source and have the second write clobber the first.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const commit = useCallback(
    (patch: AgentDocumentPatch): Promise<void> => {
      if (!mainRef) return Promise.resolve();
      const operation = queueRef.current
        .catch(() => undefined)
        .then(async () => {
          const current = await mainRef.read();
          const next = patchAgentDocument(current, patch);
          if (next !== current) {
            await mainRef.write(next);
            // Seed the cache with what we just wrote rather than refetching:
            // the backend resyncs the row from this write, and a refetch here
            // would race that resync.
            queryClient.setQueryData(docKey, next);
          }
        });
      queueRef.current = operation;
      return operation;
    },
    [mainRef, queryClient, docKey],
  );

  return {
    ready: !!mainRef && source !== undefined,
    isLoading: !!mainRef && isLoading,
    workerType: source ? readWorkerType(source) : '',
    list,
    commit,
  };
}

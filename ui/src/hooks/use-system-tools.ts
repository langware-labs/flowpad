import { useCallback, useRef, useSyncExternalStore } from 'react';
import { systemTools, SystemActivity, ActivityProgress, ScanInfo, LastScanResult } from '@sdk';
import type { AssetFilter } from '@src/components/assets/assetFilter';

export interface SystemToolsSnapshot {
  currentActivity: SystemActivity | null;
  activityProgress: ActivityProgress | null;
  scanInfo: ScanInfo | null;
  lastScanResult: LastScanResult | null;
  busy: boolean;
}

/**
 * Translate an `AssetFilter` (UI shape: scope + projectIds) into the SDK's
 * `{ scope, projectIds }` query-param shape, applying the same semantics as
 * `applyFilterToParams` does for /search:
 *
 * - scope='all'      + projectIds non-empty → scope='user,project', project_ids=…
 * - scope='all'      + projectIds empty     → no scope filter (full default rebuild)
 * - scope='user'                            → scope='user', no project_ids
 * - scope='project'                         → scope='project', project_ids=…
 */
function filterToScopeOpts(
  filter: AssetFilter | undefined,
): { scope?: string; projectIds?: string[] } | undefined {
  if (!filter) return undefined;
  if (filter.scope === 'all') {
    if (filter.projectIds.length > 0) {
      return { scope: 'user,project', projectIds: filter.projectIds };
    }
    return undefined; // full-default: no narrowing
  }
  if (filter.scope === 'user') {
    return { scope: 'user' };
  }
  if (filter.scope === 'project') {
    return { scope: 'project', projectIds: filter.projectIds };
  }
  return undefined;
}

function buildSnapshot(): SystemToolsSnapshot {
  return {
    currentActivity: systemTools.currentActivity,
    activityProgress: systemTools.activityProgress,
    scanInfo: systemTools.scanInfo,
    lastScanResult: systemTools.lastScanResult,
    busy: systemTools.currentActivity !== null,
  };
}

function shallowEqual(a: SystemToolsSnapshot, b: SystemToolsSnapshot): boolean {
  return (
    a.currentActivity === b.currentActivity &&
    a.activityProgress === b.activityProgress &&
    a.scanInfo === b.scanInfo &&
    a.lastScanResult === b.lastScanResult &&
    a.busy === b.busy
  );
}

export function useSystemTools() {
  const snapshotRef = useRef<SystemToolsSnapshot>(buildSnapshot());

  const subscribe = useCallback((cb: () => void) => {
    systemTools.on('state_changed', cb);
    return () => systemTools.off('state_changed', cb);
  }, []);

  const getSnapshot = useCallback(() => {
    const next = buildSnapshot();
    if (shallowEqual(snapshotRef.current, next)) return snapshotRef.current;
    snapshotRef.current = next;
    return snapshotRef.current;
  }, []);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const indexType = useCallback(
    (typeName: string, filter?: AssetFilter) =>
      systemTools.indexType(typeName, filterToScopeOpts(filter)),
    [],
  );

  const resetAndRescan = useCallback(
    (filter?: AssetFilter) => systemTools.resetAndRescan(filterToScopeOpts(filter)),
    [],
  );

  return {
    ...snapshot,
    clearIndex:       systemTools.clearIndex.bind(systemTools),
    clearAllData:     systemTools.clearAllData.bind(systemTools),
    backup:           systemTools.backup.bind(systemTools),
    archive:          systemTools.archive.bind(systemTools),
    restore:          systemTools.restore.bind(systemTools),
    indexType,
    indexTypes:       systemTools.indexTypes.bind(systemTools),
    resetAndRescan,
    getPaths:         systemTools.getPaths.bind(systemTools),
    getStats:         systemTools.getStats.bind(systemTools),
    getDbSettings:    systemTools.getDbSettings.bind(systemTools),
    setDbPath:        systemTools.setDbPath.bind(systemTools),
    openBackupFolder: systemTools.openBackupFolder.bind(systemTools),
    openDbFolder:     systemTools.openDbFolder.bind(systemTools),
    openLogsFolder:   systemTools.openLogsFolder.bind(systemTools),
  };
}

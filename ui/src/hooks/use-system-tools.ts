import { LazyAsset } from '@sdk/lazy';
import { useLazyAsset } from '@sdk/react/hooks/useLazyAsset';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { systemTools, SystemActivity, IndexProgressTable, ScanInfo, LastScanResult } from '@sdk';

export interface SystemToolsSnapshot {
  currentActivity: SystemActivity | null;
  progressTable: IndexProgressTable | null;
  scanInfo: ScanInfo | null;
  lastScanResult: LastScanResult | null;
  busy: boolean;
}

function buildSnapshot(): SystemToolsSnapshot {
  return {
    currentActivity: systemTools.currentActivity,
    progressTable: systemTools.progressTable,
    scanInfo: systemTools.scanInfo,
    lastScanResult: systemTools.lastScanResult,
    busy: systemTools.currentActivity !== null,
  };
}

function shallowEqual(a: SystemToolsSnapshot, b: SystemToolsSnapshot): boolean {
  return (
    a.currentActivity === b.currentActivity &&
    a.progressTable === b.progressTable &&
    a.scanInfo === b.scanInfo &&
    a.lastScanResult === b.lastScanResult &&
    a.busy === b.busy
  );
}

export function useSystemTools() {
  useLazyAsset(LazyAsset.IndexActivity, undefined, { priority: 'background' });
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

  return {
    ...snapshot,
    clearIndex:       systemTools.clearIndex.bind(systemTools),
    clearAllData:     systemTools.clearAllData.bind(systemTools),
    backup:           systemTools.backup.bind(systemTools),
    archive:          systemTools.archive.bind(systemTools),
    restore:          systemTools.restore.bind(systemTools),
    indexType:        systemTools.indexType.bind(systemTools),
    indexTypes:       systemTools.indexTypes.bind(systemTools),
    indexProjectSessions: systemTools.indexProjectSessions.bind(systemTools),
    resetAndRescan:   systemTools.resetAndRescan.bind(systemTools),
    getPaths:         systemTools.getPaths.bind(systemTools),
    getStats:         systemTools.getStats.bind(systemTools),
    getDbSettings:    systemTools.getDbSettings.bind(systemTools),
    setDbPath:        systemTools.setDbPath.bind(systemTools),
    openBackupFolder: systemTools.openBackupFolder.bind(systemTools),
    openDbFolder:     systemTools.openDbFolder.bind(systemTools),
    openLogsFolder:   systemTools.openLogsFolder.bind(systemTools),
  };
}

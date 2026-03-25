import { useCallback, useRef, useSyncExternalStore } from 'react';
import { systemTools, SystemActivity, ActivityProgress, ScanInfo } from '@sdk';

export interface SystemToolsSnapshot {
  currentActivity: SystemActivity | null;
  activityProgress: ActivityProgress | null;
  scanInfo: ScanInfo | null;
  busy: boolean;
}

function buildSnapshot(): SystemToolsSnapshot {
  return {
    currentActivity: systemTools.currentActivity,
    activityProgress: systemTools.activityProgress,
    scanInfo: systemTools.scanInfo,
    busy: systemTools.currentActivity !== null,
  };
}

function shallowEqual(a: SystemToolsSnapshot, b: SystemToolsSnapshot): boolean {
  return (
    a.currentActivity === b.currentActivity &&
    a.activityProgress === b.activityProgress &&
    a.scanInfo === b.scanInfo &&
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

  return {
    ...snapshot,
    clearIndex:       systemTools.clearIndex.bind(systemTools),
    clearAllData:     systemTools.clearAllData.bind(systemTools),
    backup:           systemTools.backup.bind(systemTools),
    archive:          systemTools.archive.bind(systemTools),
    restore:          systemTools.restore.bind(systemTools),
    indexType:        systemTools.indexType.bind(systemTools),
    indexTypes:       systemTools.indexTypes.bind(systemTools),
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

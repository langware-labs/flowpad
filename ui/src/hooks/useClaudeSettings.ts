import { ClaudeSettingsJsonRecordList } from '@sdk';
import { useState, useEffect, useCallback, useRef } from 'react';

interface UseClaudeSettingsResult {
  userRecords: ClaudeSettingsJsonRecordList | null;
  projectRecords: ClaudeSettingsJsonRecordList | null;
  localRecords: ClaudeSettingsJsonRecordList | null;
  isLoading: boolean;
  error: string | null;
  reload: () => void;
}

export function useClaudeSettings(
  computeNodeId: string | undefined,
  projectDir: string | undefined,
  poll = false,
): UseClaudeSettingsResult {
  const [userRecords, setUserRecords] = useState<ClaudeSettingsJsonRecordList | null>(null);
  const [projectRecords, setProjectRecords] = useState<ClaudeSettingsJsonRecordList | null>(null);
  const [localRecords, setLocalRecords] = useState<ClaudeSettingsJsonRecordList | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTrigger, setReloadTrigger] = useState(0);
  const hasLoadedOnce = useRef(false);

  const reload = useCallback(() => {
    setReloadTrigger((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!computeNodeId) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    const loadAll = async () => {
      // Only show loading spinner on initial load, not on poll refreshes
      // This prevents remounting ClaudeSettingsPanel and losing search state
      if (!hasLoadedOnce.current) setIsLoading(true);
      setError(null);

      try {
        const userList = ClaudeSettingsJsonRecordList.forUser(computeNodeId);
        const projectList = projectDir
          ? ClaudeSettingsJsonRecordList.forProject(computeNodeId, projectDir)
          : null;
        const localList = projectDir
          ? ClaudeSettingsJsonRecordList.forLocal(computeNodeId, projectDir)
          : null;

        // Load all scopes in parallel
        const results = await Promise.allSettled([
          userList.load(),
          projectList?.load(),
          localList?.load(),
        ]);

        if (cancelled) return;

        // User scope — propagate errors
        if (results[0].status === 'fulfilled') {
          setUserRecords(userList);
        } else {
          console.warn('Failed to load user settings:', results[0].reason);
          setUserRecords(null);
        }

        // Project and local scopes — 404 is expected (file may not exist)
        if (results[1]?.status === 'fulfilled') {
          setProjectRecords(projectList);
        } else {
          setProjectRecords(null);
        }

        if (results[2]?.status === 'fulfilled') {
          setLocalRecords(localList);
        } else {
          setLocalRecords(null);
        }

        hasLoadedOnce.current = true;
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load settings');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void loadAll();

    return () => {
      cancelled = true;
    };
  }, [computeNodeId, projectDir, reloadTrigger]);

  // Refresh on focus / tab-visible (instead of a timer) when enabled.
  // The settings files only change when the user edits them elsewhere, so
  // re-reading when the tab becomes active is enough — no idle polling
  // while the tab merely sits open.
  useEffect(() => {
    if (!poll) return;

    let lastReload = 0;
    const refreshIfActive = () => {
      if (document.visibilityState !== 'visible') return;
      // Guard the double-fire when `focus` and `visibilitychange` both land.
      const now = Date.now();
      if (now - lastReload < 100) return;
      lastReload = now;
      reload();
    };

    document.addEventListener('visibilitychange', refreshIfActive);
    window.addEventListener('focus', refreshIfActive);

    return () => {
      document.removeEventListener('visibilitychange', refreshIfActive);
      window.removeEventListener('focus', refreshIfActive);
    };
  }, [poll, reload]);

  return { userRecords, projectRecords, localRecords, isLoading, error, reload };
}

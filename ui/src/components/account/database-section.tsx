import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { DatabasePaths, DbSettings } from '@sdk';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { Button } from '@src/components/ui/button';
import { notify } from '@src/notifications';
import { BarChart3, Copy, FolderOpen } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DbStatsDialog } from './db-stats';
import { Trans, useLingui } from '@lingui/react/macro';

const LS_KEY = 'flow_db_path_settings';
const DEFAULT_DB_PATH = '~/.flow/db/flowpad_db';

interface DbPathSettings {
  paths: string[];
  selected: string | null;
}

export function DatabaseSection() {
  const { t } = useLingui();
  const {
    currentActivity,
    backup,
    clearAllData,
    getPaths,
    getDbSettings,
    setDbPath,
    openBackupFolder,
    openDbFolder,
    openLogsFolder,
  } = useSystemTools();
  const isClearing = currentActivity === 'clear';
  const isBackingUp = currentActivity === 'archive';
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showDbStats, setShowDbStats] = useState(false);
  const [paths, setPaths] = useState<DatabasePaths | null>(null);

  const [dbPathState, setDbPathState] = useState<DbPathSettings>(() => {
    try {
      return (
        (JSON.parse(localStorage.getItem(LS_KEY) ?? 'null') as DbPathSettings | null) ?? { paths: [], selected: null }
      );
    } catch {
      return { paths: [], selected: null };
    }
  });
  const [activeDbPath, setActiveDbPath] = useState<string | null>(null);
  const [defaultDbPath, setDefaultDbPath] = useState(DEFAULT_DB_PATH);
  const [isCustomInput, setIsCustomInput] = useState(false);
  const [customInputValue, setCustomInputValue] = useState('');
  const [isSwitching, setIsSwitching] = useState(false);
  const didRestoreRef = useRef(false);

  useEffect(() => {
    void getPaths().then(setPaths).catch(console.error);
  }, [getPaths]);

  useEffect(() => {
    void getDbSettings()
      .then((result: DbSettings) => {
        setActiveDbPath(result.db_path);
        setDefaultDbPath(result.default_path);
      })
      .catch(console.error);
  }, [getDbSettings]);

  useEffect(() => {
    if (didRestoreRef.current) return;
    const savedPath = dbPathState.selected;
    if (savedPath !== null) {
      didRestoreRef.current = true;
      void applyPath(savedPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyPath = async (path: string) => {
    setIsSwitching(true);
    try {
      const result = await setDbPath(path);
      setActiveDbPath(result.db_path);
      notify.success({ title: t`Database switched`, message: result.db_path });
    } catch (error) {
      notify.error({ title: t`Error`, message: error instanceof Error ? error.message : t`Failed to switch database` });
    } finally {
      setIsSwitching(false);
    }
  };

  const selectPath = async (value: string) => {
    if (value === '__enter__') {
      setIsCustomInput(true);
      return;
    }
    const newSelected = value === '__default__' ? null : value;
    const newState = { ...dbPathState, selected: newSelected };
    localStorage.setItem(LS_KEY, JSON.stringify(newState));
    setDbPathState(newState);
    await applyPath(newSelected ?? defaultDbPath);
  };

  const applyCustomPath = async () => {
    const trimmed = customInputValue.trim();
    if (!trimmed) return;
    setIsSwitching(true);
    try {
      const result = await setDbPath(trimmed);
      setActiveDbPath(result.db_path);
      const newPaths = [trimmed, ...dbPathState.paths.filter((p) => p !== trimmed)].slice(0, 10);
      const newState: DbPathSettings = { paths: newPaths, selected: trimmed };
      localStorage.setItem(LS_KEY, JSON.stringify(newState));
      setDbPathState(newState);
      setIsCustomInput(false);
      setCustomInputValue('');
      notify.success({ title: t`Database switched`, message: result.db_path });
    } catch (error) {
      notify.error({ title: t`Error`, message: error instanceof Error ? error.message : t`Failed to switch database` });
    } finally {
      setIsSwitching(false);
    }
  };

  const confirmClearDb = async () => {
    setShowClearConfirm(false);
    try {
      const result = await clearAllData();
      notify.success({ title: t`Database Cleared`, message: result.message || t`All data cleared. Redirecting...` });
      setTimeout(() => {
        window.location.href = '/';
      }, 1500);
    } catch (error) {
      notify.error({ title: t`Error`, message: error instanceof Error ? error.message : t`Failed to clear database` });
    }
  };

  const handleBackupDb = async () => {
    try {
      const result = await backup();
      notify.success({ title: t`Database Backed Up`, message: result.message });
    } catch (error) {
      notify.error({ title: t`Error`, message: error instanceof Error ? error.message : t`Failed to backup database` });
    }
  };

  const handleOpenFolder = async (folderType: 'backup' | 'db' | 'logs') => {
    try {
      if (folderType === 'backup') await openBackupFolder();
      else if (folderType === 'db') await openDbFolder();
      else await openLogsFolder();
    } catch (error) {
      notify.error({
        title: t`Error`,
        message: error instanceof Error ? error.message : t`Failed to open ${folderType} folder`,
      });
    }
  };

  const handleCopyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      notify.success({ title: t`Copied`, message: t`Path copied to clipboard` });
    } catch {
      notify.error({ title: t`Error`, message: t`Failed to copy path to clipboard` });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          <Trans>Database Path</Trans>
        </label>
        <select
          value={dbPathState.selected ?? '__default__'}
          onChange={(e) => void selectPath(e.target.value)}
          disabled={isSwitching}
          className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="__default__">
            <Trans>Default ({defaultDbPath})</Trans>
          </option>
          {dbPathState.paths.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
          <option value="__enter__">
            <Trans>+ Enter path...</Trans>
          </option>
        </select>
        {isCustomInput && (
          <div className="flex gap-2">
            <input
              type="text"
              placeholder={t`/path/to/db`}
              value={customInputValue}
              onChange={(e) => setCustomInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void applyCustomPath();
              }}
              autoFocus
              className="flex h-8 flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button size="sm" disabled={isSwitching || !customInputValue.trim()} onClick={() => void applyCustomPath()}>
              Apply
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setIsCustomInput(false);
                setCustomInputValue('');
              }}
            >
              Cancel
            </Button>
          </div>
        )}
        {activeDbPath && (
          <p className="truncate font-mono text-xs text-muted-foreground">
            <Trans>Active: {activeDbPath}</Trans>
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => void handleBackupDb()} disabled={isBackingUp} className="flex-1">
          {isBackingUp ? t`Backing up...` : t`Backup DB`}
        </Button>
        <Button variant="outline" onClick={() => setShowDbStats(true)} className="flex-1">
          <BarChart3 className="me-2 h-4 w-4" />
          <Trans>DB Stats</Trans>
        </Button>
      </div>
      <Button variant="destructive" onClick={() => setShowClearConfirm(true)} disabled={isClearing} className="w-full">
        {isClearing ? t`Clearing...` : t`Clear All Data`}
      </Button>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => void handleOpenFolder('backup')} className="flex-1">
          <FolderOpen className="me-2 h-4 w-4" />
          <Trans>Open Backup Folder</Trans>
        </Button>
        <Button variant="outline" onClick={() => void handleOpenFolder('db')} className="flex-1">
          <FolderOpen className="me-2 h-4 w-4" />
          <Trans>Open DB Folder</Trans>
        </Button>
      </div>
      <Button variant="outline" onClick={() => void handleOpenFolder('logs')} className="w-full">
        <FolderOpen className="me-2 h-4 w-4" />
        <Trans>Open Logs Folder</Trans>
      </Button>
      {paths?.logs_folder && (
        <div
          className="flex cursor-pointer items-center gap-2 rounded bg-muted/50 px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          onClick={() => void handleCopyPath(paths.logs_folder)}
          title={t`Click to copy path`}
        >
          <Copy className="h-3 w-3 flex-shrink-0" />
          <span className="truncate font-mono">{paths.logs_folder}</span>
        </div>
      )}

      <ConfirmDialog
        open={showClearConfirm}
        onOpenChange={setShowClearConfirm}
        title={t`Clear All Data`}
        description={t`Are you sure you want to clear all data from the database? This will also clear the scan index. A backup will be created first.`}
        confirmLabel={t`Clear All Data`}
        variant="destructive"
        onConfirm={() => void confirmClearDb()}
      />

      <DbStatsDialog open={showDbStats} onOpenChange={setShowDbStats} />
    </div>
  );
}

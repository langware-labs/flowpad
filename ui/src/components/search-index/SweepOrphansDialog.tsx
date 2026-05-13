import apiClient from '@sdk/client';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { useIndexStatus, type IndexStatusPerType } from '@src/hooks/use-index-status';
import { Ghost, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

const BASE = '/graph/compute_node/@local/fs-records';

export type SweepAction = 'ignore' | 'delete';

interface SweepOrphansDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, scopes the dialog to a single type. When omitted, lists every type with orphans. */
  scopeType?: string | null;
  /** Pre-fetched per-type rows from the page. The dialog stays in sync via useIndexStatus.refresh() after each action. */
  perType: IndexStatusPerType[];
  /** Total across all types — drives the toolbar badge upstream; passed here for the summary line. */
  totalOrphans: number;
}

export function SweepOrphansDialog({
  open,
  onOpenChange,
  scopeType,
  perType,
  totalOrphans,
}: SweepOrphansDialogProps) {
  const [action, setAction] = useState<SweepAction>('ignore');
  const [scanning, setScanning] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const { refresh: refreshIndexStatus } = useIndexStatus();

  const orphanRows = useMemo(() => {
    const rows = perType.filter((p) => p.orphan_count > 0);
    if (scopeType) return rows.filter((p) => p.type_name === scopeType);
    return rows.sort((a, b) => b.orphan_count - a.orphan_count);
  }, [perType, scopeType]);

  const scopeTotal = useMemo(
    () => orphanRows.reduce((s, r) => s + r.orphan_count, 0),
    [orphanRows],
  );

  // Re-scan: a no-op-effect index call that re-walks roots, updates the
  // orphan flags on DB rows, and emits progress so the footer pill +
  // page progress bar update. Hooks into the same WS stream the rest of
  // the page uses.
  const handleRescan = useCallback(async () => {
    setScanning(true);
    try {
      await apiClient.post(`${BASE}/index?orphan_action=index`);
    } finally {
      setScanning(false);
      refreshIndexStatus();
    }
  }, [refreshIndexStatus]);

  // Sweep: POST /fs-records/index?orphan_action=ignore|delete, optionally
  // scoped to one type. Same backend path the indexer uses internally; WS
  // progress fires automatically.
  const handleSweep = useCallback(async () => {
    setSweeping(true);
    try {
      const url = scopeType
        ? `${BASE}/index?type=${encodeURIComponent(scopeType)}&orphan_action=${action}`
        : `${BASE}/index?orphan_action=${action}`;
      await apiClient.post(url);
    } finally {
      setSweeping(false);
      refreshIndexStatus();
      onOpenChange(false);
    }
  }, [scopeType, action, refreshIndexStatus, onOpenChange]);

  const busy = scanning || sweeping;
  const title = scopeType ? `Orphan ${scopeType} records` : 'Orphan records';
  const headerCount = scopeType ? scopeTotal : totalOrphans;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ghost className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            {title}
            {headerCount > 0 && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                {headerCount}
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            An <span className="font-medium">orphan</span> is a row in the search index whose source
            file is gone from disk. The indexer detects them on every run and marks them with{' '}
            <code className="font-mono">orphan_since</code>. The file is already gone; sweeping just
            removes the stale row from search so results stay clean.
          </DialogDescription>
        </DialogHeader>

        {orphanRows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
            <Ghost className="h-8 w-8 opacity-30" />
            <p className="font-medium text-foreground">No orphans found.</p>
            <p className="text-xs">
              {scopeType
                ? `Every ${scopeType} row has a source file on disk.`
                : 'Every indexed row has a source file on disk.'}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 h-7 gap-1.5 text-xs"
              onClick={() => void handleRescan()}
              disabled={busy}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${scanning ? 'animate-spin' : ''}`} />
              {scanning ? 'Rescanning…' : 'Re-scan now'}
            </Button>
          </div>
        ) : (
          <>
            <div className="max-h-[40vh] overflow-y-auto rounded border bg-card">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/50 text-muted-foreground">
                    <th className="py-1.5 pl-3 pr-4 text-left font-medium">Type</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Orphans</th>
                  </tr>
                </thead>
                <tbody>
                  {orphanRows.map((r) => (
                    <tr key={r.type_name} className="border-b last:border-0">
                      <td className="py-1.5 pl-3 pr-4 font-mono">{r.type_name}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-amber-600 dark:text-amber-400">
                        {r.orphan_count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <fieldset className="flex flex-col gap-2 text-xs">
              <legend className="font-medium">Sweep action</legend>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="sweep-action"
                  className="mt-0.5"
                  checked={action === 'ignore'}
                  onChange={() => setAction('ignore')}
                  disabled={busy}
                />
                <span>
                  <span className="font-medium">Ignore</span> — remove the DB row, keep the shadow
                  record dir at <code className="font-mono">~/.flow/records/&lt;type&gt;/&lt;id&gt;/</code>{' '}
                  as a forensic breadcrumb. <span className="text-muted-foreground">(recommended)</span>
                </span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="sweep-action"
                  className="mt-0.5"
                  checked={action === 'delete'}
                  onChange={() => setAction('delete')}
                  disabled={busy}
                />
                <span>
                  <span className="font-medium">Delete</span> — remove the DB row{' '}
                  <em>and</em> the shadow record dir. Reclaims disk space; no recovery path.
                </span>
              </label>
            </fieldset>
          </>
        )}

        <DialogFooter className="gap-2">
          {orphanRows.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => void handleRescan()}
              disabled={busy}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${scanning ? 'animate-spin' : ''}`} />
              Re-scan
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => onOpenChange(false)} disabled={busy}>
            Close
          </Button>
          {orphanRows.length > 0 && (
            <Button
              variant="default"
              size="sm"
              className="h-8 gap-1.5 text-xs bg-amber-600 text-white hover:bg-amber-700"
              onClick={() => void handleSweep()}
              disabled={busy}
            >
              {sweeping ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              {sweeping ? 'Sweeping…' : `Sweep ${scopeTotal} (${action})`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

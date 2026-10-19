/**
 * CommandStatusViewer — modal showing the per-process restart-required diff.
 *
 * Answers: why is the Restart button glowing? Renders the payload captured at
 * the last successful ``start_pty()`` ("Loaded") next to the live snapshot
 * computed from the entity's current fields ("Current"). Rows that differ
 * are highlighted; the header summarises the count.
 *
 * Backed by the read-only ``agentic_process/<id>/restart-info`` action.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AgenticProcess, ActionInfo, dataManager } from '@sdk';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { RefreshCw, X } from 'lucide-react';
import { useLingui, Trans } from '@lingui/react/macro';

type SnapshotPayload = {
  generic?: Record<string, unknown>;
  worker?: Record<string, unknown>;
};

type ChangedField = {
  section: 'generic' | 'worker';
  field: string;
  loaded: unknown;
  current: unknown;
};

type RestartInfoData = {
  restart_required: boolean;
  running: boolean;
  worker_type: string | null;
  loaded: SnapshotPayload | null;
  current: SnapshotPayload;
  changed: ChangedField[];
};

interface Props {
  open: boolean;
  onClose: () => void;
  process: AgenticProcess | null;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function fieldNames(loaded: SnapshotPayload | null, current: SnapshotPayload, section: 'generic' | 'worker'): string[] {
  const l = loaded?.[section] ?? {};
  const c = current?.[section] ?? {};
  return Array.from(new Set([...Object.keys(l), ...Object.keys(c)])).sort();
}

export function CommandStatusViewer({ open, onClose, process }: Props) {
  const { t } = useLingui();
  const [data, setData] = useState<RestartInfoData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const processId = process?.id ?? null;

  const fetchInfo = useCallback(async () => {
    if (!processId) return;
    setLoading(true);
    setError(null);
    try {
      const action = new ActionInfo('restart-info', 'agentic_process', processId, 'GET');
      const result = await dataManager.callAction<null, RestartInfoData>(action);
      setData(result ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t`Failed to load command status`);
    } finally {
      setLoading(false);
    }
  }, [processId]);

  useEffect(() => {
    if (!open) {
      setData(null);
      setError(null);
      return;
    }
    void fetchInfo();
  }, [open, fetchInfo]);

  const changedSet = useMemo(() => {
    const map = new Map<string, ChangedField>();
    for (const c of data?.changed ?? []) {
      map.set(`${c.section}.${c.field}`, c);
    }
    return map;
  }, [data]);

  const changedCount = data?.changed.length ?? 0;
  const restartRequired = !!data?.restart_required;
  const noLoadedYet = data && data.loaded === null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="flex flex-col gap-0 p-0" style={{ width: 'min(820px, 92vw)', maxHeight: '85vh' }}>
        <DialogHeader className="shrink-0 border-b border-border px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <DialogTitle className="text-sm font-medium">
              <Trans>Command Status</Trans>
            </DialogTitle>
            <div className="flex items-center gap-1">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => void fetchInfo()}
                      disabled={loading || !processId}
                      className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent disabled:opacity-40"
                      aria-label={t`Refresh`}
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <Trans>Refresh</Trans>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent"
                aria-label={t`Close`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-auto px-4 py-3">
          {error && (
            <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          {!error && !data && (
            <div className="py-8 text-center text-xs text-muted-foreground">
              {loading ? t`Loading…` : processId ? t`No data.` : t`No process selected.`}
            </div>
          )}

          {data && (
            <>
              <StatusHeader
                restartRequired={restartRequired}
                changedCount={changedCount}
                workerType={data.worker_type}
                running={data.running}
                noLoadedYet={!!noLoadedYet}
              />

              <SnapshotSection
                title={t`Generic options`}
                section="generic"
                fields={fieldNames(data.loaded, data.current, 'generic')}
                loaded={data.loaded?.generic ?? null}
                current={data.current.generic ?? {}}
                changed={changedSet}
                showLoaded={!noLoadedYet}
              />

              <SnapshotSection
                title={t`Worker options${data.worker_type ? ` (${data.worker_type})` : ''}`}
                section="worker"
                fields={fieldNames(data.loaded, data.current, 'worker')}
                loaded={data.loaded?.worker ?? null}
                current={data.current.worker ?? {}}
                changed={changedSet}
                showLoaded={!noLoadedYet}
              />
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

interface StatusHeaderProps {
  restartRequired: boolean;
  changedCount: number;
  workerType: string | null;
  running: boolean;
  noLoadedYet: boolean;
}

function StatusHeader({ restartRequired, changedCount, workerType, running, noLoadedYet }: StatusHeaderProps) {
  const { t } = useLingui();
  let headline: string;
  let pillClass: string;
  if (noLoadedYet) {
    headline = t`Process not started yet`;
    pillClass = 'bg-muted text-muted-foreground';
  } else if (restartRequired) {
    headline = t`Restart required — ${changedCount} ${changedCount === 1 ? 'field' : 'fields'} changed`;
    pillClass = 'bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/40';
  } else {
    headline = t`No restart needed`;
    pillClass = 'bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/30';
  }

  const subtitleBits: string[] = [];
  if (workerType) subtitleBits.push(workerType);
  subtitleBits.push(running ? t`running` : t`stopped`);

  return (
    <div className="mb-3 rounded-md border border-border bg-card/50 px-3 py-2">
      <div className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium ${pillClass}`}>
        {headline}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">{subtitleBits.join(' · ')}</div>
      {noLoadedYet && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          <Trans>
            Showing current configuration only — there is no loaded snapshot until the first successful start.
          </Trans>
        </div>
      )}
    </div>
  );
}

interface SnapshotSectionProps {
  title: string;
  section: 'generic' | 'worker';
  fields: string[];
  loaded: Record<string, unknown> | null;
  current: Record<string, unknown>;
  changed: Map<string, ChangedField>;
  showLoaded: boolean;
}

function SnapshotSection({ title, section, fields, loaded, current, changed, showLoaded }: SnapshotSectionProps) {
  const { t } = useLingui();
  return (
    <div className="mb-4">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      {fields.length === 0 ? (
        <div className="rounded border border-border bg-card/30 px-2 py-2 text-xs text-muted-foreground">
          <Trans>(no fields)</Trans>
        </div>
      ) : (
        <div className="overflow-hidden rounded border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-2 py-1.5 text-start font-medium" style={{ width: '32%' }}>
                  <Trans>Field</Trans>
                </th>
                {showLoaded && (
                  <th className="px-2 py-1.5 text-start font-medium" style={{ width: '34%' }}>
                    <Trans>Loaded</Trans>
                  </th>
                )}
                <th className="px-2 py-1.5 text-start font-medium">
                  <Trans>Current</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => {
                const key = `${section}.${f}`;
                const diff = changed.get(key);
                const rowClass = diff ? 'bg-amber-500/10' : '';
                const lVal = loaded ? loaded[f] : undefined;
                const cVal = current[f];
                return (
                  <tr key={key} className={`border-t border-border ${rowClass}`}>
                    <td className="px-2 py-1.5 font-mono text-[11px] text-foreground/90">
                      {diff && (
                        <span className="me-1" aria-label={t`changed`}>
                          🔶
                        </span>
                      )}
                      {f}
                    </td>
                    {showLoaded && (
                      <td className="break-all px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                        {formatValue(lVal)}
                      </td>
                    )}
                    <td className="break-all px-2 py-1.5 font-mono text-[11px] text-foreground">{formatValue(cVal)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * PTYEventsViewer — modal Dialog listing every ``PtyEvent`` fire on a shell.
 *
 * Mirrors the existing PTYViewer notion: header (title + shell id slice +
 * copy/expand affordances), stats row, two-pane split (table + detail panel),
 * substring filter, empty state. Data comes from the in-memory ring buffer
 * on ``PtyConnection`` via ``shell.getPtyEventFires()`` plus a live
 * ``shell.onPtyEventFire(fn)`` subscription. No backend.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { Badge } from '@src/components/ui/badge';
import { Check, ClipboardList, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, X, Zap } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Shell } from '@sdk';

interface PtyEventFire {
  id: string;
  ts: number;
  patternSource: string;
  label?: string;
  line: string;
  match: string[];
  duringReplay: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  shell: Shell | null;
}

function formatRelative(ts: number, base: number | undefined): string {
  if (!base) return new Date(ts).toLocaleTimeString();
  const ms = ts - base;
  if (ms < 1000) return `+${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `+${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  const rs = s - m * 60;
  return `+${m}m${rs.toFixed(0).padStart(2, '0')}s`;
}

function formatAbsolute(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  const mmm = d.getMilliseconds().toString().padStart(3, '0');
  return `${hh}:${mm}:${ss}.${mmm}`;
}

function buildLogText(shellId: string, fires: readonly PtyEventFire[]): string {
  if (!fires.length) return `PTY Events Log — Shell: ${shellId}\n(no fires)\n`;
  const base = fires[0]?.ts;
  const SEP = '─'.repeat(82);
  const lines: string[] = [
    `PTY Events Log — Shell: ${shellId}`,
    SEP,
    `${fires.length} fires`,
    SEP,
    '',
    ` ${'time'.padEnd(10)} │ ${'replay'.padEnd(6)} │ ${'label / pattern'.padEnd(28)} │ matched line`,
    `${'─'.repeat(12)}┼${'─'.repeat(8)}┼${'─'.repeat(30)}┼${'─'.repeat(28)}`,
  ];
  for (const f of fires) {
    const time = formatRelative(f.ts, base);
    const replay = f.duringReplay ? 'replay' : 'live';
    const tag = (f.label ?? f.patternSource).slice(0, 28);
    const line = f.line.replace(/\s+/g, ' ').slice(0, 60);
    lines.push(` ${time.padEnd(10)} │ ${replay.padEnd(6)} │ ${tag.padEnd(28)} │ ${line}`);
  }
  return lines.join('\n');
}

export function PTYEventsViewer({ open, onClose, shell }: Props) {
  const { t } = useLingui();
  const [fires, setFires] = useState<PtyEventFire[]>([]);
  const [registeredCount, setRegisteredCount] = useState(0);
  const [selected, setSelected] = useState<PtyEventFire | null>(null);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [tableExpanded, setTableExpanded] = useState(false);
  const [splitPct, setSplitPct] = useState(50);
  const [copied, setCopied] = useState(false);

  const splitContainerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  // Seed initial state + subscribe to new fires
  useEffect(() => {
    if (!open || !shell) {
      setFires([]);
      setSelected(null);
      setRegisteredCount(0);
      return;
    }
    setFires([...shell.getPtyEventFires()]);
    setRegisteredCount(shell.getRegisteredPtyEventCount());
    const unsub = shell.onPtyEventFire((fire) => {
      setFires((prev) => {
        const next = prev.length >= 200 ? prev.slice(prev.length - 199) : prev;
        return [...next, fire];
      });
    });
    return () => {
      unsub();
    };
  }, [open, shell]);

  // Refresh registered count periodically — watchers can come and go while
  // the dialog is open, e.g. ProcessToolbar.useEffect cycles.
  useEffect(() => {
    if (!open || !shell) return;
    const id = setInterval(() => setRegisteredCount(shell.getRegisteredPtyEventCount()), 1000);
    return () => clearInterval(id);
  }, [open, shell]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return fires;
    return fires.filter((f) => {
      const tag = (f.label ?? f.patternSource).toLowerCase();
      return tag.includes(q) || f.line.toLowerCase().includes(q);
    });
  }, [fires, filter]);

  const uniquePatternCount = useMemo(() => {
    const set = new Set<string>();
    for (const f of fires) set.add(f.label ?? f.patternSource);
    return set.size;
  }, [fires]);

  const baseTs = fires[0]?.ts;

  const handleCopyLog = useCallback(() => {
    if (!shell) return;
    navigator.clipboard.writeText(buildLogText(shell.id, filtered)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [shell, filtered]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.max(20, Math.min(80, pct)));
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setSelected(null);
          onClose();
        }
      }}
    >
      <DialogContent className={`flex flex-col ${expanded ? 'max-h-[95vh] max-w-[95vw]' : 'max-h-[85vh] max-w-4xl'}`}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pe-8 text-sm">
            <Zap className="h-3.5 w-3.5 text-amber-400" />
            <Trans>PTY Events</Trans>
            {shell && <span className="font-mono text-xs text-muted-foreground">{shell.id.slice(0, 8)}</span>}
            <div className="ms-auto flex items-center gap-1">
              {fires.length > 0 && (
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button onClick={handleCopyLog} className="text-muted-foreground hover:text-foreground">
                        {copied ? (
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <ClipboardList className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">
                      <Trans>Copy as log</Trans>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              <button onClick={() => setExpanded((e) => !e)} className="text-muted-foreground hover:text-foreground">
                {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </button>
            </div>
          </DialogTitle>
        </DialogHeader>

        {/* Stats row */}
        <div className="flex gap-4 border-b pb-2 text-xs text-muted-foreground">
          <span>
            fires: <b className="text-foreground">{fires.length}</b>
          </span>
          <span>
            unique patterns: <b className="text-foreground">{uniquePatternCount}</b>
          </span>
          <span>
            registered watchers: <b className="text-foreground">{registeredCount}</b>
          </span>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t`Filter by label, pattern, or matched line…`}
            className="ms-auto w-72 rounded border bg-background px-2 py-0.5 font-mono text-[11px] outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        {fires.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Zap className="h-8 w-8 text-muted-foreground/40" />
            <span>
              <Trans>No PTY events have fired yet.</Trans>
            </span>
            <span className="text-xs">
              <Trans>
                Watchers register patterns via <code className="font-mono">Shell.addTrigger</code>; matched lines appear
                here.
              </Trans>
            </span>
            {registeredCount > 0 && (
              <span className="text-xs">
                {registeredCount} watcher{registeredCount === 1 ? '' : 's'} active.
              </span>
            )}
          </div>
        ) : (
          <div ref={splitContainerRef} className="flex min-h-0 flex-1">
            {/* Fire table */}
            <div
              className="min-h-0 overflow-auto"
              style={{ width: tableExpanded || !selected ? '100%' : `${splitPct}%`, flexShrink: 0 }}
            >
              <table className="w-full font-mono text-xs">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b text-muted-foreground">
                    <th className="w-24 px-2 py-1 text-start">
                      <Trans>time</Trans>
                    </th>
                    <th className="w-12 px-2 py-1 text-start">
                      <Trans>replay</Trans>
                    </th>
                    <th className="w-48 px-2 py-1 text-start">
                      <Trans>label / pattern</Trans>
                    </th>
                    <th className="px-2 py-1 text-start">
                      <span className="flex items-center gap-1">
                        <Trans>matched line</Trans>
                        {tableExpanded && selected && (
                          <button
                            onClick={() => setTableExpanded(false)}
                            className="hover:text-foreground"
                            title={t`Show detail panel`}
                          >
                            <PanelLeftClose className="h-3 w-3" />
                          </button>
                        )}
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((fire) => {
                    const isSelected = selected?.id === fire.id;
                    return (
                      <tr
                        key={fire.id}
                        className={`cursor-pointer border-b border-border/30 ${isSelected ? 'bg-primary/10' : 'hover:bg-muted/30'}`}
                        onClick={() => setSelected(fire)}
                      >
                        <td className="px-2 py-0.5 text-muted-foreground" title={formatAbsolute(fire.ts)}>
                          {formatRelative(fire.ts, baseTs)}
                        </td>
                        <td className="px-2 py-0.5">
                          {fire.duringReplay ? (
                            <span className="text-[9px] text-yellow-400" title={t`Fired during replay (pre-attach)`}>
                              <Trans>replay</Trans>
                            </span>
                          ) : (
                            <span className="text-[9px] text-muted-foreground/50">—</span>
                          )}
                        </td>
                        <td className="px-2 py-0.5">
                          <Badge variant="outline" className="h-4 px-1 text-[10px]" title={fire.patternSource}>
                            {fire.label ?? fire.patternSource}
                          </Badge>
                        </td>
                        <td className="max-w-[400px] truncate px-2 py-0.5 text-muted-foreground" title={fire.line}>
                          {fire.line || <Trans>(empty line)</Trans>}
                        </td>
                      </tr>
                    );
                  })}
                  {filtered.length === 0 && filter && (
                    <tr>
                      <td colSpan={4} className="px-2 py-4 text-center text-muted-foreground">
                        No fires match "<span className="font-medium">{filter}</span>".
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Draggable divider */}
            {selected && !tableExpanded && (
              <div
                onMouseDown={handleDragStart}
                className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/50 active:bg-primary"
              />
            )}

            {/* Detail panel */}
            {selected && !tableExpanded && (
              <div className="flex min-h-0 flex-1 flex-col ps-2">
                <div className="mb-1 flex items-center justify-between border-b pb-1 text-xs text-muted-foreground">
                  <span>
                    Fire <b className="font-mono text-foreground">{selected.id.slice(0, 8)}</b>
                    {selected.duringReplay && <span className="ms-2 text-yellow-400">(replay)</span>}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setTableExpanded(true)}
                      className="hover:text-foreground"
                      title={t`Expand table`}
                    >
                      <PanelLeftOpen className="h-3 w-3" />
                    </button>
                    <button onClick={() => setSelected(null)} className="hover:text-foreground">
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                </div>
                <div className="min-h-0 flex-1 space-y-2 overflow-auto text-xs">
                  <DetailRow label={t`label`}>
                    {selected.label ?? (
                      <span className="italic text-muted-foreground">
                        <Trans>(none)</Trans>
                      </span>
                    )}
                  </DetailRow>
                  <DetailRow label={t`pattern`}>
                    <code className="break-all font-mono">{selected.patternSource}</code>
                  </DetailRow>
                  <DetailRow label={t`time`}>
                    <span className="font-mono">{formatAbsolute(selected.ts)}</span>
                    <span className="ms-2 text-muted-foreground">
                      ({formatRelative(selected.ts, baseTs)} <Trans>from first</Trans>)
                    </span>
                  </DetailRow>
                  <DetailRow label={t`line`}>
                    <pre className="whitespace-pre-wrap break-all rounded bg-muted/20 p-2 font-mono">
                      {selected.line || <Trans>(empty)</Trans>}
                    </pre>
                  </DetailRow>
                  {selected.match.length > 1 && (
                    <DetailRow label={`groups (${selected.match.length - 1})`}>
                      <ol className="list-decimal ps-5 font-mono">
                        {selected.match.slice(1).map((g, i) => (
                          <li key={i} className="break-all">
                            {g ?? (
                              <span className="italic text-muted-foreground">
                                <Trans>(undefined)</Trans>
                              </span>
                            )}
                          </li>
                        ))}
                      </ol>
                    </DetailRow>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-20 flex-shrink-0 text-muted-foreground">{label}:</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

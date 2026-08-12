/**
 * The activity feed — the subject of the Events screen.
 *
 * One row per fact, newest first, with a fire nested under the envelope that
 * caused it. Rewritten from the old Signals feed onto tailwind + the shared
 * primitives: that file used 74 unscoped global CSS selectors with hardcoded
 * hex behind `var(--x, fallback)` references to variables that do not exist, so
 * the fallbacks always won and the panes ignored the theme entirely.
 */
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Pause, Play, Trash2, X } from 'lucide-react';
import { Trans, useLingui, useLingui } from '@lingui/react/macro';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { cn } from '@src/lib/utils';
import { STATUS_CLASS, STATUS_LABEL, type EventRow } from './feed-model';

interface Props {
  rows: EventRow[];
  cap: number;
  totalEvents: number;
  paused: boolean;
  ruleFilterName: string | null;
  /** Feed narrowed to one subject, in FlowEvent colon form. */
  targetFilter: string | null;
  onClearTarget: () => void;
  onTogglePause: () => void;
  onClear: () => void;
}

function timeOf(at: number): string {
  if (!at) return '--:--:--';
  // hour/minute/second must be requested EXPLICITLY. Asking for
  // fractionalSecondDigits alone makes Intl narrow the output to just that
  // field, which renders a timestamp as a bare "141".
  return new Date(at).toLocaleTimeString(undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

function StatusPill({ row }: { row: EventRow }) {
  if (row.status === 'none' && row.kind === 'event') return null;
  return (
    <span className={cn('shrink-0 rounded px-1.5 py-px text-[9px] uppercase tracking-wider', STATUS_CLASS[row.status])}>
      {STATUS_LABEL[row.status]}
    </span>
  );
}

function ChildRow({ row }: { row: EventRow }) {
  const fire = row.fire;
  return (
    <div className="flex items-baseline gap-2 py-0.5 ps-6 text-[11px] text-muted-foreground">
      <span className="text-muted-foreground/60">└</span>
      <StatusPill row={row} />
      <span className="font-medium text-foreground">{row.ruleName}</span>
      {row.gist && <span className="truncate">{row.gist}</span>}
      {fire?.agentic_process_id && (
        <Badge variant="outline" className="h-4 shrink-0 px-1 font-mono text-[9px]">
          {fire.agentic_process_id.slice(0, 8)}
        </Badge>
      )}
    </div>
  );
}

function FeedRow({ row }: { row: EventRow }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  const detail = row.kind === 'event' ? row.event : row.fire;

  return (
    <li className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-baseline gap-2 px-3 py-1.5 text-start text-[11px] hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
      >
        <Chevron className="h-3 w-3 shrink-0 self-center text-muted-foreground/60" />
        <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{timeOf(row.at)}</span>
        {/* A top-level fire leads with the RULE — "which of my rules did this"
            is the question the row exists to answer. An envelope leads with its
            tag, because it has no rule of its own. */}
        {row.kind === 'fire' && row.ruleName ? (
          <span className="shrink-0 font-medium">{row.ruleName}</span>
        ) : (
          <span className="shrink-0 font-mono font-medium">{row.label}</span>
        )}
        <span className="truncate font-mono text-muted-foreground">{row.subject}</span>
        {/* One right-hand group, so `ms-auto` has a single home instead of
            hopping between two siblings depending on whether a gist exists. */}
        <span className="ms-auto flex shrink-0 items-baseline gap-2">
          {row.gist && <span className="truncate text-muted-foreground/80">{row.gist}</span>}
          <StatusPill row={row} />
        </span>
      </button>

      {row.children.map((child) => (
        <ChildRow key={child.key} row={child} />
      ))}

      {open && (
        <div className="border-t border-border/40 bg-muted/30 px-3 py-2">
          {row.kind === 'event' && row.event && (
            <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[10px]">
              <dt className="text-muted-foreground">id</dt>
              <dd className="truncate">{row.event.id}</dd>
              <dt className="text-muted-foreground">origin</dt>
              <dd>{row.event.ctx?.origin ?? '—'}</dd>
              <dt className="text-muted-foreground">actor</dt>
              <dd>{row.event.ctx?.actor ?? '—'}</dd>
              <dt className="text-muted-foreground">scope</dt>
              <dd className="truncate">{row.event.ctx?.scope?.join(' ← ') || '—'}</dd>
            </dl>
          )}
          {row.kind === 'fire' && row.fire && (
            <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[10px]">
              <dt className="text-muted-foreground">rule</dt>
              <dd className="truncate">{row.fire.rule_name}</dd>
              <dt className="text-muted-foreground">event id</dt>
              <dd className="truncate">{row.fire.event_id ?? '—'}</dd>
              <dt className="text-muted-foreground">caused by</dt>
              <dd className="truncate">{row.fire.cause_event_id ?? '—'}</dd>
              <dt className="text-muted-foreground">reason</dt>
              <dd className="truncate">{row.fire.reason || '—'}</dd>
            </dl>
          )}
          <pre className="max-h-60 overflow-auto rounded bg-background p-2 font-mono text-[10px] leading-relaxed">
            {JSON.stringify(detail ?? {}, null, 2)}
          </pre>
        </div>
      )}
    </li>
  );
}

export function EventFeed({
  rows,
  cap,
  totalEvents,
  paused,
  ruleFilterName,
  targetFilter,
  onClearTarget,
  onTogglePause,
  onClear,
}: Props) {
  const { t } = useLingui();
  const [filter, setFilter] = useState('');

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (r) =>
        r.label.toLowerCase().includes(needle) ||
        r.subject.toLowerCase().includes(needle) ||
        r.ruleName.toLowerCase().includes(needle),
    );
  }, [rows, filter]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t`Filter by tag, subject or rule…`}
          className="h-7 max-w-xs text-xs"
        />
        {ruleFilterName && (
          <Badge variant="outline" className="h-6 gap-1 px-2 text-[10px]">
            <Trans>rule: {ruleFilterName}</Trans>
          </Badge>
        )}
        {targetFilter && (
          <Badge variant="outline" className="h-6 gap-1 px-2 font-mono text-[10px]">
            {targetFilter}
            <button
              type="button"
              onClick={onClearTarget}
              className="text-muted-foreground hover:text-foreground"
              aria-label={t`Clear subject filter`}
            >
              <X className="size-3" />
            </button>
          </Badge>
        )}
        <div className="ms-auto flex items-center gap-1">
          <span className="me-1 font-mono text-[10px] tabular-nums text-muted-foreground">
            {shown.length !== rows.length ? `${shown.length} / ${rows.length}` : rows.length}
            {totalEvents >= cap ? ` (capped ${cap})` : ''}
          </span>
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={onTogglePause}>
            {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            {paused ? <Trans>Resume</Trans> : <Trans>Pause</Trans>}
          </Button>
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={onClear}>
            <Trash2 className="h-3 w-3" />
            <Trans>Clear</Trans>
          </Button>
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="max-w-md text-center text-xs text-muted-foreground">
            <Trans>
              Nothing yet. Rule fires are read from each rule&apos;s log; live events show what the backend has
              forwarded since it started — the bus keeps no history of its own.
            </Trans>
          </p>
        </div>
      ) : (
        <ol className="flex-1 overflow-y-auto">
          {shown.map((row) => (
            <FeedRow key={row.key} row={row} />
          ))}
        </ol>
      )}
    </div>
  );
}

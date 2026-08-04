/**
 * One configured source, and whether it is actually alive.
 *
 * "Alive" is not one field. A source can be enabled and still never poll —
 * `config_error` makes `is_due` refuse it permanently, which is exactly the
 * failure this card exists to make visible. So it shows health, the countdown
 * to the next poll, AND an explicit "parked" state when those disagree.
 *
 * The two links are URL-first: they navigate, and the destination reads its own
 * scope off the URL. Nothing here writes context.
 */
import { useCallback, useMemo, useState } from 'react';
import { DataSource, DataSourceCursor, QueryRequest } from '@sdk';
import { Antenna, ChevronDown, ChevronRight, History, Pencil, RadioTower, Trash2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { timeSince, timeUntil } from '@src/utils/duration';
import { ViewType } from '@src/types/ViewType';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { Button } from '@src/components/ui/button';
import { Switch } from '@src/components/ui/switch';
import { Card, CardContent, CardHeader } from '@src/components/ui/card';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { healthStyle } from './provider-catalog';
import { ReplayDialog } from './ReplayDialog';

export function DataSourceCard({
  source,
  onEdit,
  onDeleted,
}: {
  source: DataSource;
  onEdit: (source: DataSource) => void;
  onDeleted: () => void;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [replayOpen, setReplayOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const Icon = iconForType(DataSource.type);

  const cursorQuery = useMemo(
    () =>
      new QueryRequest({
        type: DataSourceCursor.type,
        scope: [],
        query: { data_source_id: source.id },
        name: `data-sources:cursors:${source.id}`,
      }),
    [source.id],
  );
  const { data: cursors = [] } = useEntitiesQuery<DataSourceCursor>(cursorQuery, { enabled: open });

  /** Run an action and surface whatever it says. */
  const run = useCallback(async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setNote(null);
    try {
      setNote(await fn());
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const toggleEnabled = useCallback(
    (next: boolean) =>
      void run('enable', async () => {
        source.enabled = next;
        await source.save();
        return next ? t`Enabled — it will poll on the next tick.` : t`Paused.`;
      }),
    [run, source, t],
  );

  const remove = useCallback(() => {
    // No success note: `onDeleted` unmounts this card, so anything set here is
    // written to a component nobody will see again. A failure still surfaces,
    // via run()'s catch.
    void run('delete', async () => {
      // `delete()`, not `destroy()` — the TS entity has no destroy, and the
      // backend cascade hangs off `delete_by_id`, which is what this reaches.
      await source.delete();
      onDeleted();
      return '';
    });
  }, [run, source, onDeleted]);

  // Enabled, but `is_due` will still refuse it. Without calling this out the
  // card reads as healthy-but-idle and the user waits forever.
  const parked = source.enabled && source.health === 'config_error';
  const health = healthStyle(source.health);

  return (
    <Card className={`border-l-4 ${health.border}`}>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0 p-3 pb-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={source.name}>
          {source.name || source.provider || source.id.slice(0, 8)}
        </span>
        <span className={`rounded px-1.5 py-0.5 text-[11px] ${health.chip}`}>{health.label}</span>
        <Switch
          checked={source.enabled}
          onCheckedChange={toggleEnabled}
          disabled={busy === 'enable'}
          aria-label={source.enabled ? t`Disable this source` : t`Enable this source`}
        />
      </CardHeader>

      <CardContent className="space-y-2 p-3 pt-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span title={t`Last successful sync`}>
            <Trans>synced {timeSince(source.last_synced_at)}</Trans>
          </span>
          <span title={t`Next scheduled poll`}>
            {source.enabled ? <Trans>next {timeUntil(source.next_poll_at)}</Trans> : <Trans>paused</Trans>}
          </span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{source.provider}</span>
          {/* The agent transport's channel is `gmail` while its provider is
              `agent` — showing only the provider is actively misleading. */}
          {source.channel && source.channel !== source.provider && (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{source.channel}</span>
          )}
        </div>

        {parked && (
          <p className="rounded bg-destructive/10 p-2 text-xs text-destructive">
            <Trans>
              Parked: a <code>config_error</code> source is skipped by the scheduler, so it will not
              poll again on its own. <strong>Pull changes</strong> clears the latch.
            </Trans>
            {source.error_detail ? ` (${source.error_detail})` : ''}
          </p>
        )}

        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            disabled={!!busy}
            onClick={() => void run('poll', async () => (await source.pollNow()).detail)}
          >
            {busy === 'poll' ? '…' : t`Pull changes`}
          </Button>
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => setReplayOpen(true)}>
            {t`Replay…`}
          </Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => onEdit(source)}>
            <Pencil className="size-3.5" /> {t`Edit`}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title={t`Events from this source`}
            onClick={() =>
              // The `filter` option is carried but not yet honoured: the events
              // feed grew out of Signals in a parallel slice and reads `trigger`,
              // not a free-text filter. The link lands on the right screen; the
              // narrowing needs one `initialFilter` prop over there.
              navigation.openDock(
                new DockPointer(ViewType.EVENTS, undefined, { filter: `data_source:${source.id}` }),
              )
            }
          >
            <RadioTower className="size-3.5" /> {t`Events`}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title={t`Worker runs this source spawned`}
            onClick={() => navigation.openDock(DockPointer.forProcessRuns({ data_source_id: source.id }))}
          >
            <History className="size-3.5" /> {t`Runs`}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={!!busy}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>

        {note && <p className="text-xs text-muted-foreground">{note}</p>}

        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <Trans>Streams</Trans>
        </button>

        {open && (
          <ul className="space-y-1">
            {cursors.length === 0 ? (
              <li className="text-xs text-muted-foreground">
                <Trans>No cursors yet — this source has not polled.</Trans>
              </li>
            ) : (
              cursors.map((c) => (
                <li key={c.id} className="flex items-center gap-2 text-xs">
                  <Antenna className="size-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate" title={c.stream_key}>
                    {c.stream_label || c.stream_key}
                  </span>
                  <span className={`rounded px-1 py-0.5 text-[10px] ${healthStyle(c.health).chip}`}>
                    {healthStyle(c.health).label}
                  </span>
                  <span className="text-muted-foreground">{timeSince(c.last_synced_at)}</span>
                  {c.consecutive_failures > 0 && (
                    <span className="rounded bg-destructive/10 px-1 py-0.5 text-[10px] text-destructive">
                      {c.consecutive_failures}×
                    </span>
                  )}
                </li>
              ))
            )}
          </ul>
        )}
      </CardContent>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        variant="destructive"
        title={t`Delete this data source?`}
        // Say what else goes: nothing cascades by default, so the backend's
        // destroy override is the only reason these disappear together.
        description={t`"${source.name || source.provider}" will be removed along with its streams and every record it ingested. This cannot be undone.`}
        confirmLabel={t`Delete`}
        onConfirm={remove}
      />

      <ReplayDialog
        source={source}
        open={replayOpen}
        onOpenChange={setReplayOpen}
        onDone={(msg) => setNote(msg)}
      />
    </Card>
  );
}

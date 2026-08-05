/**
 * One configured source, and whether it is actually alive.
 *
 * "Alive" is not one field. A source can be enabled and still never poll —
 * `config_error` makes `is_due` refuse it permanently, which is exactly the
 * failure this card exists to make visible. So it shows health, the countdown to
 * the next poll, AND an explicit "parked" state when those disagree.
 *
 * Status plus ONE verb. Everything else is delegated: the rest of the actions to
 * `SourceMenu`, the stream rows to `SourceStreams`, and every dialog to the view
 * (so N cards don't mount 2N of them). `Pull changes` stays a real button
 * because it is the thing an operator came here to press.
 */
import { useCallback, useMemo, useState } from 'react';
import { DataSource, DataSourceCursor, QueryRequest } from '@sdk';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { timeSince, timeUntil } from '@src/utils/duration';
import { Button } from '@src/components/ui/button';
import { Card, CardContent, CardHeader } from '@src/components/ui/card';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { healthStyle } from './health-style';
import { SourceMenu } from './SourceMenu';
import { SourceStreams } from './SourceStreams';

interface Props {
  source: DataSource;
  onEdit: (source: DataSource) => void;
  onReplay: (source: DataSource) => void;
  onDelete: (source: DataSource) => void;
}

export function DataSourceCard({ source, onEdit, onReplay, onDelete }: Props) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const Icon = iconForType(DataSource.type);

  // Gated on `open`: a collapsed card issues no request at all (the hook
  // returns before `watchQuery` when disabled), and the filter means one
  // source's poll only ever repaints one card. The COUNT does not come from
  // here — it rides on the source, so a collapsed grid watches nothing.
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

  /**
   * Every verb on this screen reports through `notify`, including the two that
   * live here. An inline note on the card would be a SECOND result channel —
   * which one you got would depend on which action you picked, and the card's
   * copy would sit there stale until the next verb ran.
   */
  const pull = useCallback(async () => {
    setBusy(true);
    try {
      // Not synchronous: the detail says "on the next tick", which is the whole
      // expectation this toast exists to set.
      notify.success({ title: source.name || source.provider, message: (await source.pollNow()).detail });
    } catch (error) {
      notify.error({
        title: t`Could not pull ${source.name || source.provider}`,
        message: errorMessage(error, t`The source was not queued.`),
      });
    } finally {
      setBusy(false);
    }
  }, [source, t]);

  const toggleEnabled = useCallback(async () => {
    const next = !source.enabled;
    try {
      source.enabled = next;
      await source.save();
      notify.success({ title: next ? t`Enabled — it polls on the next tick.` : t`Paused.` });
    } catch (error) {
      source.enabled = !next; // the save failed, so the row never moved
      notify.error({
        title: t`Could not update ${source.name || source.provider}`,
        message: errorMessage(error, t`The change was not saved.`),
      });
    }
  }, [source, t]);

  // Enabled, but `is_due` will still refuse it. Without calling this out the
  // card reads as healthy-but-idle and the user waits forever.
  const parked = source.enabled && source.health === 'config_error';
  const health = healthStyle(source.health);

  return (
    <Card className={cn('flex flex-col border-l-[3px]', health.border)}>
      <CardHeader className="flex flex-row items-start gap-2 space-y-0 p-3 pb-1.5">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium leading-tight" title={source.name}>
            {source.name || source.provider || source.id.slice(0, 8)}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <span>{source.provider}</span>
            {/* The agent transport's channel is `gmail` while its provider is
                `agent` — showing only the provider is actively misleading. */}
            {source.channel && source.channel !== source.provider && <span>· {source.channel}</span>}
          </div>
        </div>

        <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium', health.chip)}>
          {source.enabled ? health.label : t`paused`}
        </span>

        <SourceMenu
          source={source}
          onToggleEnabled={() => void toggleEnabled()}
          onEdit={onEdit}
          onReplay={onReplay}
          onDelete={onDelete}
        />
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-2 p-3 pt-0">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span title={t`Last successful sync`}>
            <Trans>synced {timeSince(source.last_synced_at)}</Trans>
          </span>
          <span title={t`Next scheduled poll`}>
            {source.enabled ? <Trans>next {timeUntil(source.next_poll_at)}</Trans> : '—'}
          </span>
        </div>

        {parked && (
          <p className="rounded bg-destructive/10 px-2 py-1.5 text-[11px] leading-snug text-destructive">
            <Trans>
              Parked — the scheduler skips a <code>config_error</code> source, so it will not poll
              again on its own. <strong>Pull changes</strong> clears the latch.
            </Trans>
            {source.error_detail ? ` (${source.error_detail})` : ''}
          </p>
        )}

        <div className="mt-auto flex items-center gap-2 pt-1">
          <Button
            size="sm"
            variant="secondary"
            className="h-7 gap-1.5"
            disabled={busy}
            onClick={() => void pull()}
          >
            <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
            {t`Pull changes`}
          </Button>

          <button
            type="button"
            className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            <Plural value={source.stream_count} one="# stream" other="# streams" />
          </button>
        </div>

        {open && <SourceStreams cursors={cursors} />}
      </CardContent>
    </Card>
  );
}

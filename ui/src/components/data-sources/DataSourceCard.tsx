/**
 * One configured source, and whether it is actually alive.
 *
 * "Alive" is not one field, and the card's job is to show the disagreements.
 * Two axes: `status` (should this be running) and `health` (does it work). A
 * source can be `active` and still never poll — `config_error` makes `is_due`
 * refuse it permanently — and it can be perfectly healthy and still ingest
 * nothing, because it is in `setup` waiting on the user to invite a bot to a
 * Slack channel. Both of those read as healthy-and-idle if the card shows one
 * field, so it shows the lifecycle chip, the health, the countdown, an explicit
 * "parked" state, and a setup panel with the verb that ends it.
 *
 * Status plus ONE verb. Everything else is delegated: the rest of the actions to
 * `SourceMenu`, the stream rows to `SourceStreams`, and every dialog to the view
 * (so N cards don't mount 2N of them). `Pull changes` stays a real button
 * because it is the thing an operator came here to press.
 */
import { useCallback, useMemo, useState } from 'react';
import { DataSource, DataSourceCursor, QueryRequest } from '@sdk';
import { CheckCircle2, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { timeSince, timeUntil } from '@src/utils/duration';
import { Button } from '@src/components/ui/button';
import { Card, CardContent, CardHeader } from '@src/components/ui/card';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { WikiButton } from '@src/components/wiki-tip';
import { healthStyle } from './health-style';
import { setupWiki } from './provider-catalog';
import { statusStyle } from './status-style';
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

  /**
   * Re-run the setup check. Idempotent, so it is safe to press after every
   * attempt — which is the actual interaction: invite the bot, press, repeat
   * for whatever is still listed.
   */
  const verify = useCallback(async () => {
    setBusy(true);
    try {
      const result = await source.verify();
      if (result.ready) {
        notify.success({ title: source.name || source.provider, message: result.detail });
      } else {
        // Not an error — nothing failed, the user simply has one more step. A
        // red toast here would send them looking for a broken thing.
        notify.info({ title: t`Not ready yet`, message: result.detail });
      }
    } catch (error) {
      notify.error({
        title: t`Could not verify ${source.name || source.provider}`,
        message: errorMessage(error, t`The check did not run.`),
      });
    } finally {
      setBusy(false);
    }
  }, [source, t]);

  const toggleEnabled = useCallback(async () => {
    const previous = source.status;
    // Un-pausing returns it to `new` rather than `active`: the backend decides
    // whether this driver still owes a setup step, and a source paused mid-setup
    // must not skip it.
    const next = source.isActive || source.needsSetup ? 'disabled' : 'new';
    try {
      source.status = next;
      await source.save();
      notify.success({
        title: next === 'disabled' ? t`Paused.` : t`Resumed — it polls on the next tick.`,
      });
    } catch (error) {
      source.status = previous; // the save failed, so the row never moved
      notify.error({
        title: t`Could not update ${source.name || source.provider}`,
        message: errorMessage(error, t`The change was not saved.`),
      });
    }
  }, [source, t]);

  // Active, but `is_due` will still refuse it. Without calling this out the
  // card reads as healthy-but-idle and the user waits forever.
  const parked = source.isActive && source.health === 'config_error';
  const health = healthStyle(source.health);
  const status = statusStyle(source.status);
  // The lifecycle answers first. Health on a source that is not running is
  // stale by construction — it describes the last time it ran, which for a
  // source that never has is "never synced", i.e. no information at all.
  const chip = source.isActive ? health : status;
  const wiki = setupWiki(source.provider);

  return (
    <Card className={cn('flex flex-col border-l-[3px]', chip.border)}>
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

        <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium', chip.chip)}>
          {chip.label}
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
            {source.isActive ? <Trans>next {timeUntil(source.next_poll_at)}</Trans> : '—'}
          </span>
        </div>

        {source.needsSetup && (
          <div className="rounded bg-amber-500/10 px-2 py-1.5 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
            <div className="flex items-start gap-1.5">
              <p className="flex-1">
                {source.setup_detail || t`Finish setup, then press Verify.`}
              </p>
              {/* The info affordance is a wiki page, not a tooltip: "invite the
                  bot" is a multi-step task performed in ANOTHER application, and
                  a hover card cannot be read while doing it. */}
              {wiki && <WikiButton wikiword={wiki} label={t`How to finish setup`} />}
            </div>
            <Button
              size="sm"
              variant="secondary"
              className="mt-1.5 h-7 gap-1.5"
              disabled={busy}
              data-testid={`source-verify-${source.id}`}
              onClick={() => void verify()}
            >
              <CheckCircle2 className="size-3.5" />
              {t`Verify`}
            </Button>
          </div>
        )}

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
            // Pulling an unverified source would fail in a way that says
            // nothing useful — the driver refuses before it reaches the network.
            disabled={busy || source.needsSetup}
            title={source.needsSetup ? t`Verify the setup first.` : undefined}
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

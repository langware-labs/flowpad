/**
 * One configured source as a row of the sources list, and whether it is
 * actually alive.
 *
 * "Alive" is not one field, and the row's job is to show the disagreements.
 * Two axes: `status` (should this be running) and `health` (does it work). A
 * source can be `active` and still never poll — `config_error` makes `is_due`
 * refuse it permanently — and it can be perfectly healthy and still ingest
 * nothing, because it is in `setup` waiting on the user to invite a bot to a
 * Slack channel. Both of those read as healthy-and-idle if the row shows one
 * field, so it shows the lifecycle chip, the countdown, and — expanded — an
 * explicit "parked" state and a setup panel with the verb that ends it.
 *
 * Status plus ONE verb on the row. Everything else is delegated: the rest of
 * the actions to `SourceMenu`, and every dialog to the view (so N rows don't
 * mount 2N of them).
 */
import { useCallback, useState } from 'react';
import { DataSource, type DataDriver } from '@sdk';
import { CheckCircle2, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { timeSince, timeUntil } from '@src/utils/duration';
import { Button } from '@src/components/ui/button';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { WikiButton } from '@src/components/wiki-tip';
import { healthStyle } from './health-style';
import { statusStyle } from './status-style';
import { sourceIcon } from './source-icon';
import { SourceMenu } from './SourceMenu';
import { OpenFolderButton } from './OpenFolderButton';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { openDriver, openSourceFile } from './data-sources-pointer';
import { useSourceToggle } from './use-source-toggle';
import { useSourceVerify } from './use-source-verify';

interface Props {
  source: DataSource;
  /** This source's spec. Passed in rather than queried here: the specs are one
   *  global query, and a card per source asking separately is N identical
   *  subscriptions to the same rows. The view already owns the grid — and it
   *  hands over the WHOLE spec, so a third field the card wants is not a third
   *  prop and a third lookup. */
  spec?: DataDriver | null;
  onEdit: (source: DataSource) => void;
  onReplay: (source: DataSource) => void;
  onDelete: (source: DataSource) => void;
}

export function DataSourceRow({ source, spec, onEdit, onReplay, onDelete }: Props) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  // Collapsed by default, whatever the state: the pill already says "needs
  // setup" / "needs attention", and a screen of parked sources must still fit
  // on one screen. The detail is one click away.
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // The spec's glyph when one is installed, else the type's — and for a
  // multi-channel transport (agent), the CHANNEL's own glyph. A screen of
  // sources is scanned by what they reach, not by 'these are all data sources'.
  const Icon = sourceIcon(spec, source.channel);

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

  const { verify, busy: verifying } = useSourceVerify(source);
  const { toggle: toggleEnabled } = useSourceToggle(source);

  // Active, but `is_due` will still refuse it. Without calling this out the
  // card reads as healthy-but-idle and the user waits forever.
  const parked = source.isParked;
  const health = healthStyle(source.health);
  const status = statusStyle(source.status);
  // The lifecycle answers first. Health on a source that is not running is
  // stale by construction — it describes the last time it ran, which for a
  // source that never has is "never synced", i.e. no information at all.
  const chip = source.isActive ? health : status;
  // The setup page comes from the source's own manifest, so a new source
  // brings its own help rather than needing an entry in a frontend map.
  const wiki = spec?.setup_wiki || undefined;

  const Pull = (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 gap-1.5 px-2"
      // Pulling an unverified source would fail in a way that says
      // nothing useful — the driver refuses before it reaches the network.
      disabled={busy || source.needsSetup}
      title={source.needsSetup ? t`Verify the setup first.` : t`Pull changes now`}
      onClick={() => void pull()}
    >
      <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
      <span className="sr-only md:not-sr-only">{t`Pull`}</span>
    </Button>
  );

  return (
    <div
      data-testid="source-card"
      data-provider={source.provider}
      data-status={source.status}
      className={cn('border-b border-border/60 border-s-[3px]', chip.border, open && 'bg-muted/10')}
    >
      <div className={ROW_GRID}>
        {/* Identity: the brand mark, the name, and provider · channel under it. */}
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-expanded={open}
            aria-label={open ? t`Collapse` : t`Expand`}
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
          <Icon className="size-5 shrink-0" />
          <div className="flex min-w-0 items-baseline gap-2">
            {/* The name opens the source's own file; the provider opens the driver it is an instance of. */}
            <button
              type="button"
              className="truncate text-start text-sm font-medium leading-tight hover:underline disabled:no-underline"
              title={source.asset_ref ? t`Open data_source.json` : source.name}
              disabled={!source.asset_ref}
              data-testid={`data-source-file-${source.id}`}
              onClick={() => openSourceFile(navigation, source.asset_ref)}
            >
              {source.name || source.provider || source.id.slice(0, 8)}
            </button>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              <button
                type="button"
                className="hover:text-foreground hover:underline"
                title={t`Open the ${source.provider} driver`}
                data-testid={`data-source-driver-${source.id}`}
                onClick={() => openDriver(navigation, source.provider)}
              >
                {source.provider}
              </button>
              {/* The agent transport's channel is `gmail` while its provider is
                  `agent` — showing only the provider is actively misleading. */}
              {source.channel && source.channel !== source.provider && ` · ${source.channel}`}
            </span>
          </div>
        </div>

        <span className={cn('w-fit rounded-full px-2 py-0.5 text-[10px] font-medium', chip.chip)}>{chip.label}</span>

        <span className="text-xs text-muted-foreground" title={t`Last successful sync`}>
          {timeSince(source.last_synced_at)}
        </span>

        <span className="text-xs text-muted-foreground" title={t`Next scheduled poll`}>
          {source.isActive ? timeUntil(source.next_poll_at) : '—'}
        </span>

        <div className="flex items-center justify-end gap-1">
          {source.needsSetup && (
            <Button
              size="sm"
              variant="secondary"
              className="h-7 gap-1.5"
              disabled={busy || verifying}
              data-testid={`source-verify-${source.id}`}
              onClick={() => void verify()}
            >
              <CheckCircle2 className="size-3.5" />
              {t`Verify`}
            </Button>
          )}
          {Pull}
          <OpenFolderButton path={source.asset_ref} testId={`data-source-folder-${source.id}`} />
          <SourceMenu
            source={source}
            spec={spec}
            onToggleEnabled={() => void toggleEnabled()}
            onEdit={onEdit}
            onReplay={onReplay}
            onDelete={onDelete}
          />
        </div>
      </div>

      {open && (
        <div className="flex flex-col gap-2 px-4 pb-3 ps-[3.75rem]">
          {source.needsSetup && (
            <div className="flex items-start gap-1.5 rounded bg-amber-500/10 px-2 py-1.5 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
              <p className="flex-1">{source.setup_detail || t`Finish setup, then press Verify.`}</p>
              {/* The info affordance is a wiki page, not a tooltip: "invite the
                  bot" is a multi-step task performed in ANOTHER application, and
                  a hover card cannot be read while doing it. */}
              {wiki && <WikiButton wikiword={wiki} label={t`How to finish setup`} />}
            </div>
          )}

          {parked && (
            <p className="rounded bg-red-500/10 px-2 py-1.5 text-[11px] leading-snug text-red-700 dark:text-red-300">
              <Trans>
                Parked — the scheduler skips a <code>config_error</code> source, so it will not poll again on its own.{' '}
                <strong>Pull</strong> clears the latch.
              </Trans>
              {source.error_detail ? ` (${source.error_detail})` : ''}
            </p>
          )}

        </div>
      )}
    </div>
  );
}

/** The header row's look, shared by the sources table and the drivers table. */
export const HEADER_ROW =
  'border-b border-border bg-muted/30 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground';

/** The one column template the header and every row share. */
export const ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_7rem_6rem_6rem_auto] items-center gap-3 px-4 py-1.5';

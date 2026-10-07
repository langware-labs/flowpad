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
 * field, so it shows a coloured status line (parked said in its own words), the
 * countdown, and — expanded — the setup panel with the verb that ends it.
 *
 * Status plus the setup verb on the row. Everything else is delegated: the rest
 * of the actions (Pull, the folder) to `SourceMenu`, and every dialog to the view
 * (so N rows don't mount 2N of them).
 */
import { useCallback, useState } from 'react';
import { DataSource, type DataDriver } from '@sdk';
import { CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { i18n } from '@lingui/core';
import { timeSince, timeUntil } from '@src/utils/duration';
import { Button } from '@src/components/ui/button';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { WikiButton } from '@src/components/wiki-tip';
import { SetupStagesButton } from '@src/components/setup-wizard/SetupStagesButton';
import { healthStyle } from './health-style';
import { statusStyle } from './status-style';
import { sourceGlyphs } from './source-icon';
import { PARKED_DOT } from './source-look';
import { IconWithBadge } from '@src/components/graph-view/icons/IconWithBadge';
import { ChannelRouteControl } from './ChannelRouteControl';
import { SourceMenu } from './SourceMenu';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { openDriver } from './data-sources-pointer';
import { DockPointer } from '@src/navigation/DockPointer';
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
  const [pulling, setPulling] = useState(false);
  // The CHANNEL's mark — the spec's glyph, a multi-channel transport's per-channel
  // one — badged with whose way it is (Flow on WhatsApp: WhatsApp with Flowpad's
  // badge, the rule the Add-source choice card uses). A screen of sources is
  // scanned by what they reach, not by 'these are all data sources'.
  const { Base: Glyph, Badge } = sourceGlyphs(spec, source.channel);

  /**
   * Every verb on this screen reports through `notify`, including the two that
   * live here. An inline note on the card would be a SECOND result channel —
   * which one you got would depend on which action you picked, and the card's
   * copy would sit there stale until the next verb ran.
   */
  const pull = useCallback(async () => {
    setPulling(true);
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
      setPulling(false);
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

  return (
    <div
      data-testid="source-card"
      data-provider={source.provider}
      data-status={source.status}
      className={cn('border-b border-s-[3px] border-border/60', chip.border, open && 'bg-muted/10')}
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
          <IconWithBadge
            Base={Glyph}
            Badge={Badge}
            className="size-5 shrink-0"
            data-testid={`source-icon-${source.id}`}
          />
          <div className="flex min-w-0 items-baseline gap-2">
            {/* The name opens what the source DOES: this machine's event stream narrowed to it (its file is in the
                menu); the provider opens the driver it is an instance of. URL-first, like the menu's own link. */}
            <button
              type="button"
              className="truncate text-start text-sm font-medium leading-tight hover:underline"
              title={t`Show its events`}
              data-testid={`data-source-events-${source.id}`}
              onClick={() =>
                navigation.openDock(DockPointer.forAutomations({ place: 'bus', target: `data_source:${source.id}` }))
              }
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

        {/* One coloured status line: the dot is the state at a glance, the words say it. A parked source says so
            here, not only when expanded — it looks healthy and will never poll again on its own. */}
        <span
          className={cn(
            'flex min-w-0 items-center gap-1.5 text-xs font-medium',
            parked ? 'text-foreground' : chip.text,
          )}
          data-testid={`source-status-${source.id}`}
          title={parked ? t`Parked: the scheduler skips it until you pull` : undefined}
        >
          <span className={cn('size-2 shrink-0 rounded-full', parked ? PARKED_DOT : chip.dot)} />
          <span className="truncate">{parked ? t`Parked` : i18n._(chip.label)}</span>
        </span>

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
              disabled={pulling || verifying}
              data-testid={`source-verify-${source.id}`}
              onClick={() => void verify()}
            >
              <CheckCircle2 className="size-3.5" />
              {t`Verify`}
            </Button>
          )}
          <SetupStagesButton source={source} spec={spec} />
          <SourceMenu
            source={source}
            spec={spec}
            onPull={() => void pull()}
            pulling={pulling}
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

          <ChannelRouteControl source={source} />

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
/** Every column is a fixed track: each row is a grid of its own, so an `auto` actions column sized itself per row
 *  and pulled the other columns out of line with the header. */
export const ROW_GRID = 'grid grid-cols-[minmax(0,1fr)_8rem_6rem_6rem_12rem] items-center gap-3 px-4 py-1.5';

/** The rows carry a 3px status border at the start; the header a clear one, so its columns start where theirs do. */
export const HEADER_INSET = 'border-s-[3px] border-s-transparent';

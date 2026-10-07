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
import { useState } from 'react';
import { DataSource, type DataDriver } from '@sdk';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { timeSince, timeUntil } from '@src/utils/duration';
import { cn } from '@src/lib/utils';
import { sourceGlyphs } from './source-icon';
import { IconWithBadge } from '@src/components/graph-view/icons/IconWithBadge';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { openDriver, openSource } from './data-sources-pointer';
import { SourceActions, SourceSetupDetails, SourceStatusLine, sourceLook } from './source-parts';

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
  // The CHANNEL's mark — the spec's glyph, a multi-channel transport's per-channel
  // one — badged with whose way it is (Flow on WhatsApp: WhatsApp with Flowpad's
  // badge, the rule the Add-source choice card uses). A screen of sources is
  // scanned by what they reach, not by 'these are all data sources'.
  const { Base: Glyph, Badge } = sourceGlyphs(spec, source.channel);

  return (
    <div
      data-testid="source-card"
      data-provider={source.provider}
      data-status={source.status}
      className={cn('border-b border-s-[3px] border-border/60', sourceLook(source).border, open && 'bg-muted/10')}
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
            {/* The name opens the source's own page (what went through it: messages, events, settings); the
                provider opens the driver it is an instance of. URL-first. */}
            <button
              type="button"
              className="truncate text-start text-sm font-medium leading-tight hover:underline"
              title={t`Open ${source.name || source.provider}`}
              data-testid={`data-source-open-${source.id}`}
              onClick={() => openSource(navigation, source.id)}
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

        <SourceStatusLine source={source} />

        <span className="text-xs text-muted-foreground" title={t`Last successful sync`}>
          {timeSince(source.last_synced_at)}
        </span>

        <span className="text-xs text-muted-foreground" title={t`Next scheduled poll`}>
          {source.isActive ? timeUntil(source.next_poll_at) : '—'}
        </span>

        <SourceActions source={source} spec={spec} onEdit={onEdit} onReplay={onReplay} onDelete={onDelete} />
      </div>

      {open && (
        <div className="flex flex-col gap-2 px-4 pb-3 ps-[3.75rem]">
          <SourceSetupDetails source={source} spec={spec} />
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

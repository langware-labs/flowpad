/**
 * The attached channels of ONE owner — the local user's inbox or an agent's —
 * as a row of icons, Dock-style: a lit glyph with a bar under it is listening,
 * a dimmed one is paused, a badged one is parked and wants a person.
 *
 * One component, two mounts, no knowledge of which owner it serves. Its rows
 * are exactly `DataSource.find_owned(owner)` ∩ MessageSource — the same
 * `sources` query the Data Sources screen and the inbox chip already share —
 * filtered by `owner` and by the spec's `sends`. The spec, not the row's
 * `channel`: a just-attached source has no channel until its first poll, and
 * the icon must be there the moment it is created.
 *
 * The icons ARE the controls — click = the ONE pause/resume verb (`useSourceToggle`). A parked source
 * (`needsAttention`) is not toggled — the backend refuses to poll it until
 * someone finishes its setup — so the click opens the Data Sources screen.
 * Filtering the inbox by channel is deliberately NOT a click here: that is
 * navigation state and belongs in the URL. Attaching a channel is not here
 * either: that is the Data Sources screen's job.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { DataSource, type DataSourceSpec, TypeId } from '@sdk';
import { Ellipsis } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useContext } from '@src/hooks/useContext';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { cn } from '@src/lib/utils';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { sourceIcon } from '@src/components/data-sources/source-icon';
import { isMessageSourceSpec, sourcesQuery, useSourceSpecs } from '@src/components/data-sources/use-source-specs';
import { useSourceToggle } from '@src/components/data-sources/use-source-toggle';
import { ownerOf } from './channel-owner';

const EMPTY: DataSource[] = [];
/** One icon button plus its gap; the "…" button is the same size. */
const SLOT_PX = 32;

/** The owner's message sources, in a stable order — plus the spec lookup the
 *  caller needs to draw them, so a mount holds ONE specs subscription. Exported
 *  so a mount can ask "does this owner have any channel at all" from the same
 *  rows the bar shows. */
export function useAttachedChannels(owner: TypeId | null | undefined) {
  const { specFor } = useSourceSpecs();
  const { userTypeId } = useContext();
  const { data: sources = EMPTY } = useEntitiesQuery<DataSource>(sourcesQuery);
  const ownerKey = owner?.toString() ?? '';
  const localKey = userTypeId?.toString() ?? '';
  const rows = useMemo(
    () =>
      ownerKey
        ? sources
            .filter((s) => (ownerOf(s) ?? localKey) === ownerKey && isMessageSourceSpec(specFor(s.provider)))
            .sort((a, b) => (a.name || a.provider).localeCompare(b.name || b.provider))
        : EMPTY,
    [sources, specFor, ownerKey, localKey],
  );
  return { rows, specFor };
}

/** How many channel icons fit in `width` px — all of them when unmeasured
 *  (0: jsdom, display:none) or roomy; otherwise one slot is kept for "…", and
 *  folding only ONE icon to make room for it would gain nothing. */
export function visibleCount(width: number, rows: number): number {
  if (!width) return rows;
  const slots = Math.floor(width / SLOT_PX);
  return slots >= rows ? rows : Math.max(0, slots - 1);
}

type ChannelState = 'listening' | 'paused' | 'parked';
type Labels = Record<ChannelState, string>;

function channelState(source: DataSource): ChannelState {
  if (source.needsAttention) return 'parked';
  return source.isActive ? 'listening' : 'paused';
}

export function AttachedChannelsBar({ owner, className }: { owner: TypeId; className?: string }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { rows, specFor } = useAttachedChannels(owner);
  const labels: Labels = { listening: t`listening`, paused: t`paused`, parked: t`needs attention` };
  const openDataSources = () => navigation.openTab(ViewType.DATA_SOURCES);

  // Overflow: one ResizeObserver on the row (the TabStrip pattern). The row is
  // `flex-1 min-w-0`, so its width is the space AVAILABLE, not the content —
  // folding icons into "…" therefore never changes the measurement.
  const rowRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const shown = rows.slice(0, visibleCount(width, rows.length));
  const folded = rows.slice(shown.length);
  const rowProps = (source: DataSource) => ({ source, spec: specFor(source.provider), labels, onParked: openDataSources });

  return (
    <div
      ref={rowRef}
      className={cn('flex min-w-0 flex-1 items-center gap-1 overflow-hidden', className)}
      data-testid="attached-channels"
      data-owner={owner.toString()}
      role="toolbar"
      aria-label={t`Attached channels`}
    >
      {shown.map((source) => (
        <ChannelIcon key={source.id} {...rowProps(source)} />
      ))}
      {folded.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className={SLOT_CLASS} aria-label={t`More channels`} data-testid="attached-channels-more">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-48">
            {folded.map((source) => (
              <ChannelMenuItem key={source.id} {...rowProps(source)} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

const SLOT_CLASS = 'relative size-7 shrink-0 text-muted-foreground';

interface RowProps {
  source: DataSource;
  spec: DataSourceSpec | undefined;
  labels: Labels;
  onParked: () => void;
}

/** Everything one channel row needs, whichever wrapper renders it: the shared
 *  toggle (or, parked, the screen that can fix it), its glyph, its state. */
function useChannel({ source, spec, labels, onParked }: RowProps) {
  const { toggle, busy } = useSourceToggle(source);
  const state = channelState(source);
  return {
    click: () => (state === 'parked' ? onParked() : void toggle()),
    busy,
    state,
    Icon: sourceIcon(spec, source.channel),
    label: `${source.name || source.provider} · ${labels[state]}`,
  };
}

function ChannelIcon(props: RowProps) {
  const { click, busy, state, Icon, label } = useChannel(props);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={click}
          disabled={busy}
          aria-label={label}
          aria-pressed={state === 'listening'}
          className={cn(SLOT_CLASS, state === 'paused' && 'opacity-50')}
          data-testid="attached-channel"
          data-provider={props.source.provider}
          data-status={props.source.status}
          data-state={state}
        >
          <Icon />
          {/* The Dock's "running" mark: a bar under a listening channel. */}
          {state === 'listening' && <span className="absolute inset-x-2 bottom-0.5 h-0.5 rounded-full bg-emerald-500" />}
          {state === 'parked' && <span className="absolute -end-0 -top-0 size-2 rounded-full bg-destructive" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function ChannelMenuItem(props: RowProps) {
  const { click, busy, state, Icon } = useChannel(props);
  return (
    <DropdownMenuItem onSelect={click} disabled={busy} data-testid="attached-channel-item" data-provider={props.source.provider}>
      <Icon className={cn('size-3.5', state === 'paused' && 'opacity-50')} />
      <span className="flex-1 truncate">{props.source.name || props.source.provider}</span>
      <span className="text-[10px] text-muted-foreground">{props.labels[state]}</span>
    </DropdownMenuItem>
  );
}

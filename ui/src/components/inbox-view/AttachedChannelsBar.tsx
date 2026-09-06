/**
 * The attached channels of ONE owner — the local user's inbox or an agent's —
 * on the inbox's header line, as a row of round marks with a status dot
 * (presence-row pattern): green dot = listening, dashed ring = paused, "!" =
 * parked. ONE mark per channel kind (provider + channel, the identity a
 * glyph draws): several sources of one kind share a mark that carries their
 * count, and hovering it lists just those sources with their switches.
 * Clicking a mark FILTERS the list to that kind; while a filter is on, the
 * two controls give way to one × that shows everything again.
 *
 * At rest the line carries two controls: + adds a source owned by this owner,
 * and the details button opens every channel with its on/off switch and a
 * delete — the settings-list pattern. On/off is the ONE pause/resume verb
 * (`useSourceToggle`); the marks themselves never toggle.
 *
 * One component, two mounts, no knowledge of which owner it serves. Its rows
 * are exactly `DataSource.find_owned(owner)` ∩ MessageSource — the same
 * `sources` query the Data Sources screen and the row chip already share —
 * keyed on the spec's `sends`, not the row's `channel`, so a just-attached
 * source shows before its first poll.
 */
import { type ReactNode, useMemo, useState } from 'react';
import { DataSource, type DataSourceSpec, TypeId, User } from '@sdk';
import { Plus, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useContext } from '@src/hooks/useContext';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { cn } from '@src/lib/utils';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@src/components/ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Switch } from '@src/components/ui/switch';
import { DataSourceDialog } from '@src/components/data-sources/DataSourceDialog';
import { sourceIcon } from '@src/components/data-sources/source-icon';
import { isMessageSourceSpec, sourcesQuery, useSourceSpecs } from '@src/components/data-sources/use-source-specs';
import { useSourceDelete } from '@src/components/data-sources/use-source-delete';
import { useSourceToggle } from '@src/components/data-sources/use-source-toggle';
import { ownerOf } from './channel-owner';

const EMPTY: DataSource[] = [];

/** The owner's message sources, in a stable order — plus the spec lookup the
 *  caller needs to draw them, so a mount holds ONE specs subscription. The
 *  inbox calls this once and hands the rows to the line; an agent view calls
 *  it to ask "does this owner have any channel at all". */
export function useAttachedChannels(owner: TypeId | null | undefined) {
  const { specFor } = useSourceSpecs();
  // `localUser.id`, not `userTypeId`: that alias is the `@local` pointer, and rows
  // carry the user's real id.
  const { localUser } = useContext();
  const { data: sources = EMPTY } = useEntitiesQuery<DataSource>(sourcesQuery);
  const ownerKey = owner?.toString() ?? '';
  const localKey = localUser?.id ? new TypeId(User.type, localUser.id).toString() : '';
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

type SpecFor = (provider: string) => DataSourceSpec | undefined;
type ChannelState = 'on' | 'off' | 'parked';
const stateOf = (s: DataSource): ChannelState => (s.needsAttention ? 'parked' : s.status === 'disabled' ? 'off' : 'on');

/** The identity a mark draws: provider AND channel, because one transport
 *  (`agent`) reaches several channels and wears a different glyph for each. */
export const channelKeyOf = (s: DataSource) => `${s.provider}|${s.channel}`;

/** Sources of one channel kind, sharing a mark. Its state is the best of its
 *  members' — one listening source lights the mark; parked beats paused. */
interface ChannelGroup {
  key: string;
  provider: string;
  channel: string;
  sources: DataSource[];
  state: ChannelState;
}
export function groupChannels(rows: DataSource[]): ChannelGroup[] {
  const groups = new Map<string, DataSource[]>();
  for (const s of rows) {
    const list = groups.get(channelKeyOf(s));
    if (list) list.push(s);
    else groups.set(channelKeyOf(s), [s]);
  }
  return [...groups.entries()]
    .map(([key, sources]) => {
      const states = sources.map(stateOf);
      const state: ChannelState = states.includes('on') ? 'on' : states.includes('parked') ? 'parked' : 'off';
      return { key, provider: sources[0].provider, channel: sources[0].channel, sources, state };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

interface Props {
  owner: TypeId;
  /** The owner's message sources and their spec lookup — from ONE
   *  `useAttachedChannels` in the mount, which also filters its list by them. */
  rows: DataSource[];
  specFor: SpecFor;
  /** Channel keys (`channelKeyOf`) the list is narrowed to; empty = everything. */
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
  className?: string;
}

export function AttachedChannelsBar({ owner, rows, specFor, selected, onSelectedChange, className }: Props) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [addOpen, setAddOpen] = useState(false);
  const { deleting, setDeleting, remove, confirm } = useSourceDelete();
  const filtering = selected.size > 0;
  const groups = useMemo(() => groupChannels(rows), [rows]);

  const pick = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectedChange(next);
  };

  return (
    <div
      className={cn('flex min-w-0 items-center gap-2', className)}
      data-testid="attached-channels"
      data-owner={owner.toString()}
      data-filtering={filtering}
      role="toolbar"
      aria-label={t`Attached channels`}
    >
      {groups.map((group) => (
        <ChannelMark
          key={group.key}
          group={group}
          spec={specFor(group.provider)}
          filtering={filtering}
          pressed={selected.has(group.key)}
          onClick={() => pick(group.key)}
          onDelete={setDeleting}
        />
      ))}
      {filtering ? (
        <Button variant="ghost" size="icon" className={CONTROL} onClick={() => onSelectedChange(new Set())} aria-label={t`Show all channels`} data-testid="attached-channels-clear">
          <X />
        </Button>
      ) : (
        <>
          <Button variant="ghost" size="icon" className={CONTROL} onClick={() => setAddOpen(true)} aria-label={t`Add a source`} data-testid="attached-channels-add">
            <Plus />
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className={CONTROL} aria-label={t`Channel details`} data-testid="attached-channels-details">
                <SlidersHorizontal />
              </Button>
            </PopoverTrigger>
            {/* `onFocusOutside` is refused: flipping a switch disables it while it
                saves, focus falls to the body, and Radix would read that as
                "clicked elsewhere" and close the list mid-action. */}
            <PopoverContent align="end" className="w-72 p-0" onFocusOutside={(e) => e.preventDefault()}>
              <ChannelList
                title={t`Channels`}
                sources={rows}
                specFor={specFor}
                onDelete={setDeleting}
                footer={
                  <button
                    type="button"
                    className="w-full border-t border-border/60 px-3 py-2 text-start text-xs text-primary hover:bg-accent"
                    onClick={() => navigation.openTab(ViewType.DATA_SOURCES)}
                    data-testid="attached-channels-see-all"
                  >
                    {t`See all sources`}
                  </button>
                }
              />
            </PopoverContent>
          </Popover>
        </>
      )}
      {addOpen && <DataSourceDialog open onOpenChange={setAddOpen} owner={owner} only={isMessageSourceSpec} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(next) => !next && setDeleting(null)}
        variant="destructive"
        {...confirm}
        onConfirm={() => deleting && void remove(deleting)}
      />
    </div>
  );
}

const CONTROL = 'size-7 shrink-0 rounded-full text-muted-foreground';

/** One round mark per channel kind: the brand glyph, a status dot, a count when
 *  several sources share it, and — while filtering — a ring on the ones the
 *  list is narrowed to. Hovering lists just this kind's sources with their
 *  switches, the same rows the details popover shows for all. */
function ChannelMark({
  group,
  spec,
  filtering,
  pressed,
  onClick,
  onDelete,
}: {
  group: ChannelGroup;
  spec: DataSourceSpec | undefined;
  filtering: boolean;
  pressed: boolean;
  onClick: () => void;
  onDelete: (source: DataSource) => void;
}) {
  const { t } = useLingui();
  const Icon = sourceIcon(spec, group.channel);
  const { state } = group;
  const count = group.sources.length;
  const title = spec?.title || group.provider;
  // Inline, not a helper taking `t`: the lingui macro only compiles a `t` it can
  // see come from `useLingui()`.
  const stateLabel = state === 'parked' ? t`needs attention` : state === 'on' ? t`listening` : t`paused`;
  return (
    <HoverCard openDelay={150} closeDelay={120}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-pressed={pressed}
          aria-label={`${count === 1 ? group.sources[0].name || title : `${title} × ${count}`} · ${stateLabel}`}
          className={cn(
            'relative grid size-8 shrink-0 place-items-center rounded-full border-[1.5px] bg-background transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            state === 'off' ? 'border-dashed border-border' : 'border-border',
            pressed && 'border-primary ring-1 ring-primary',
            ((filtering && !pressed) || state === 'off') && '[&>svg]:opacity-45 [&>svg]:grayscale',
          )}
          data-testid="attached-channel"
          data-provider={group.provider}
          data-count={count}
          data-state={state}
        >
          <Icon className="size-[17px]" />
          {state === 'on' && <span className="absolute -bottom-0.5 -end-0.5 size-2.5 rounded-full border-2 border-background bg-emerald-500" />}
          {state === 'parked' && (
            <span className="absolute -bottom-0.5 -end-0.5 grid size-3.5 place-items-center rounded-full border-2 border-background bg-amber-500 text-[9px] font-bold leading-none text-white">
              !
            </span>
          )}
          {count > 1 && (
            <span
              className="absolute -start-1 -top-1 min-w-4 rounded-full border-2 border-background bg-muted px-1 text-[9px] font-semibold leading-3 text-foreground tabular-nums"
              data-testid="attached-channel-count"
            >
              {count}
            </span>
          )}
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-72 p-0">
        <ChannelList title={`${title} · ${stateLabel}`} sources={group.sources} specFor={specFor(spec)} onDelete={onDelete} />
      </HoverCardContent>
    </HoverCard>
  );
}

/** The one list both panels show: a header, a `ChannelRow` per source, an
 *  optional footer. The hover card scopes it to one kind, the popover to all. */
function ChannelList({
  title,
  sources,
  specFor,
  onDelete,
  footer,
}: {
  title: string;
  sources: DataSource[];
  specFor: SpecFor;
  onDelete: (source: DataSource) => void;
  footer?: ReactNode;
}) {
  const { t } = useLingui();
  return (
    <>
      <div className="px-3 pb-1 pt-2.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{title}</div>
      {sources.map((source) => (
        <ChannelRow key={source.id} source={source} spec={specFor(source.provider)} onDelete={() => onDelete(source)} />
      ))}
      {sources.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">{t`No channel is attached yet.`}</div>}
      {footer}
    </>
  );
}

/** A spec already in hand, as the lookup `ChannelList` expects. */
const specFor = (spec: DataSourceSpec | undefined): SpecFor => () => spec;

/** One line of a channel list: glyph, name, its setup note, the on/off switch
 *  and a delete. */
function ChannelRow({ source, spec, onDelete }: { source: DataSource; spec: DataSourceSpec | undefined; onDelete: () => void }) {
  const { t } = useLingui();
  const { toggle, busy } = useSourceToggle(source);
  const Icon = sourceIcon(spec, source.channel);
  const state = stateOf(source);
  return (
    <div className="flex items-center gap-2.5 px-3 py-2 text-[13px]" data-testid="attached-channel-row" data-provider={source.provider}>
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{source.name || source.provider}</span>
        {state === 'parked' && source.setup_detail && <span className="block truncate text-[11px] text-amber-500">{source.setup_detail}</span>}
      </span>
      <Switch
        checked={state !== 'off'}
        aria-busy={busy || undefined}
        onClick={(e) => e.stopPropagation()}
        onCheckedChange={() => void toggle()}
        aria-label={t`Listen on ${source.name || source.provider}`}
        data-testid="attached-channel-switch"
      />
      <button
        type="button"
        onClick={onDelete}
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
        aria-label={t`Remove ${source.name || source.provider}`}
        data-testid="attached-channel-delete"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

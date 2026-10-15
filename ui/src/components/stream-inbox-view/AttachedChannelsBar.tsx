/**
 * The attached channels of ONE owner — the local user's stream inbox or an agent's —
 * on the stream inbox's header line, as a row of round marks with a status dot
 * (presence-row pattern): green dot = listening, dashed ring = paused, "!" =
 * a person must act (`ATTENTION[kind].mark`). ONE mark per channel kind (provider + channel, the identity a
 * glyph draws): several sources of one kind share a mark that carries their
 * count, and hovering it lists just those sources with their switches.
 * Clicking a mark FILTERS the list to that kind; while a filter is on, the
 * "+" turns into a high-contrast × in the same place that shows everything
 * again. Nothing else on the line moves or disappears: the line keeps its
 * width, so the marks a person is pointing at stay where they are.
 *
 * At rest the line carries two controls — plus a call control for each channel that takes calls
 * (`CallControls`, from the driver's `calls`): + adds a source owned by this owner,
 * and the details button opens every channel with its on/off switch and a
 * delete — the settings-list pattern. On/off is the ONE pause/resume verb
 * (`useSourceToggle`); the marks themselves never toggle.
 *
 * One component, two mounts, no knowledge of which owner it serves. Its rows
 * are exactly `DataSource.find_owned(owner)` ∩ MessageSource — the same
 * `sources` query the Data Sources screen and the row chip already share —
 * keyed on the spec's `sends`, not the row's `channel`, so a just-attached
 * source shows before its first poll.
 *
 * A channel the owner has NOT connected is drawn too, while they have connected none of the
 * featured ones (`channelOffers`): the greyed glyph with a "+", which opens the add dialog on
 * that channel. It is the absence of a source, not a state of one, so it never filters.
 */
import { type ReactNode, useMemo, useState } from 'react';
import { Agent, DataSource, type DataDriver, TypeId, User } from '@sdk';
import { Plus, RefreshCw, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useContext } from '@src/hooks/useContext';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useSourceVerify } from '@src/components/data-sources/use-source-verify';
import { ViewType } from '@src/types/ViewType';
import { cn } from '@src/lib/utils';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@src/components/ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Switch } from '@src/components/ui/switch';
import { DataSourceDialog } from '@src/components/data-sources/DataSourceDialog';
import { sourceGlyphs } from '@src/components/data-sources/source-icon';
import { IconWithBadge } from '@src/components/graph-view/icons/IconWithBadge';
import {
  type ChannelOffer,
  channelOffers,
  isMessageDriverSpec,
  sourcesQuery,
  useSourceSpecs,
} from '@src/components/data-sources/use-source-specs';
import { lucideByName } from '@src/lib/lucide-by-name';
import { useSourceDelete } from '@src/components/data-sources/use-source-delete';
import { useSourceToggle } from '@src/components/data-sources/use-source-toggle';
import { CallControls } from '@src/components/voice/CallControls';
import {
  ATTENTION,
  type AttentionReason,
  type ChannelMark,
  attentionReason,
  attentionHeadline,
  attentionText,
} from '@src/components/data-sources/source-attention';
import { openSourceSetup } from '@src/components/setup-wizard/source-setup-store';
import { useSourcePull } from '@src/components/data-sources/source-parts';
import { channelKeyOf, ownerOf } from './channel-owner';

const EMPTY: DataSource[] = [];
const NO_OFFERS: ChannelOffer[] = [];

/** The owner's message sources, in a stable order — plus the spec lookup the
 *  caller needs to draw them, so a mount holds ONE specs subscription — and the
 *  channels still to connect (`offers`). The stream inbox calls this once and
 *  hands the rows to the line; an agent view calls it to ask "does this owner
 *  have any channel at all". */
export function useAttachedChannels(owner: TypeId | null | undefined) {
  const { specs, specFor, loading: specsLoading } = useSourceSpecs();
  // `localUser.id`, not `userTypeId`: that alias is the `@local` pointer, and rows
  // carry the user's real id.
  const { localUser } = useContext();
  const { data: sources = EMPTY, isLoading: sourcesLoading } = useEntitiesQuery<DataSource>(sourcesQuery);
  const ownerKey = owner?.toString() ?? '';
  const localKey = localUser?.id ? new TypeId(User.type, localUser.id).toString() : '';
  const rows = useMemo(
    () =>
      ownerKey
        ? sources
            .filter((s) => (ownerOf(s) ?? localKey) === ownerKey && isMessageDriverSpec(specFor(s.provider)))
            .sort((a, b) => (a.name || a.provider).localeCompare(b.name || b.provider))
        : EMPTY,
    [sources, specFor, ownerKey, localKey],
  );
  const forAgent = owner?.type === Agent.type;
  const offers = useMemo(
    () => (ownerKey ? channelOffers(specs, rows, forAgent) : NO_OFFERS),
    [specs, rows, ownerKey, forAgent],
  );
  // Until both lists land, `rows` is empty for want of data, not for want of channels.
  return { rows, specFor, offers, loading: specsLoading || sourcesLoading };
}

type SpecFor = (provider: string) => DataDriver | undefined;
/** How the mark draws a source, from the one classifier: lit unless its kind says otherwise. */
const markOf = (reason: AttentionReason | null): ChannelMark => (reason ? ATTENTION[reason.kind].mark : 'on');

/** Sources of one channel kind, sharing a mark. Its state is the best of its
 *  members' — one listening source lights the mark; parked beats paused — and
 *  `attention` counts the members a person must act on, so the "!" is never
 *  hidden by a listening sibling: a lit mark can still wear it. */
interface ChannelGroup {
  key: string;
  provider: string;
  channel: string;
  sources: DataSource[];
  state: ChannelMark;
  attention: number;
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
      const states = sources.map((s) => markOf(attentionReason(s)));
      const state: ChannelMark = states.includes('on') ? 'on' : states.includes('parked') ? 'parked' : 'off';
      const attention = states.filter((st) => st === 'parked').length;
      return { key, provider: sources[0].provider, channel: sources[0].channel, sources, state, attention };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

interface Props {
  owner: TypeId;
  /** The owner's message sources and their spec lookup — from ONE
   *  `useAttachedChannels` in the mount, which also filters its list by them. */
  rows: DataSource[];
  specFor: SpecFor;
  /** Channels still to connect, drawn after the attached ones (`useAttachedChannels().offers`). */
  offers?: ChannelOffer[];
  /** Channel keys (`channelKeyOf`) the list is narrowed to; empty = everything. */
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
  className?: string;
}

export function AttachedChannelsBar({
  owner,
  rows,
  specFor,
  offers = NO_OFFERS,
  selected,
  onSelectedChange,
  className,
}: Props) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  // The add dialog, and the channel it opens on when an offer was pressed.
  const [adding, setAdding] = useState<{ initial?: DataDriver } | null>(null);
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
      {offers.map((offer) => (
        <ChannelOfferMark key={offer.key} offer={offer} onConnect={() => setAdding({ initial: offer.spec })} />
      ))}
      <CallControls rows={rows} specFor={specFor} />
      {filtering ? (
        // Same size and place as the "+", so the line does not shift: only the glyph and its contrast change.
        <Button
          variant="ghost"
          size="icon"
          className={cn(CONTROL, 'bg-foreground text-background hover:bg-foreground/85 hover:text-background')}
          onClick={() => onSelectedChange(new Set())}
          aria-label={t`Show all channels`}
          data-testid="attached-channels-clear"
        >
          <X />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className={CONTROL}
          onClick={() => setAdding({})}
          aria-label={t`Add a source`}
          data-testid="attached-channels-add"
        >
          <Plus />
        </Button>
      )}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={CONTROL}
            aria-label={t`Channel details`}
            data-testid="attached-channels-details"
          >
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
      {adding && <AddChannelDialog owner={owner} initial={adding.initial} onClose={() => setAdding(null)} />}
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
// The round mark a channel is drawn as, attached or still to connect. The glyph is its
// first child — an svg, or the <img>/<span> a brand mark renders as.
const MARK =
  'relative grid size-8 shrink-0 place-items-center rounded-full border-[1.5px] transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const MARK_GREYED = '[&>:first-child]:opacity-45 [&>:first-child]:grayscale';
const MARK_BADGE = 'absolute -bottom-0.5 -end-0.5 rounded-full border-2 border-background';
const MARK_HOVER = { openDelay: 150, closeDelay: 120 };

/** The add dialog as the channel line opens it: message drivers only, on `initial` when a channel was picked. */
function AddChannelDialog({ owner, initial, onClose }: { owner: TypeId; initial?: DataDriver; onClose: () => void }) {
  return (
    <DataSourceDialog
      open
      onOpenChange={(next) => !next && onClose()}
      owner={owner}
      only={isMessageDriverSpec}
      initial={initial}
      variant="channel"
    />
  );
}

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
  spec: DataDriver | undefined;
  filtering: boolean;
  pressed: boolean;
  onClick: () => void;
  onDelete: (source: DataSource) => void;
}) {
  const { t } = useLingui();
  // The channel's mark, badged with whose way it is (Flow's), as on the data source rows.
  const { Base, Badge } = sourceGlyphs(spec, group.channel);
  const { state, attention } = group;
  const count = group.sources.length;
  const title = spec?.title || group.provider;
  // Inline, not a helper taking `t`: the lingui macro only compiles a `t` it can
  // see come from `useLingui()`. A member that needs a person names the mark
  // "needs attention" even while a sibling listens.
  const stateLabel = attention > 0 ? t`needs attention` : state === 'on' ? t`listening` : t`paused`;
  return (
    <HoverCard {...MARK_HOVER}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-pressed={pressed}
          aria-label={`${count === 1 ? group.sources[0].name || title : `${title} × ${count}`} · ${stateLabel}`}
          className={cn(
            MARK,
            'bg-background',
            state === 'off' ? 'border-dashed border-border' : 'border-border',
            pressed && 'border-primary ring-1 ring-primary',
            ((filtering && !pressed) || state === 'off') && MARK_GREYED,
          )}
          data-testid="attached-channel"
          data-provider={group.provider}
          data-count={count}
          data-state={state}
          data-attention={attention}
        >
          {/* The badge sits top-right here: bottom-right is the listening dot's. */}
          <IconWithBadge Base={Base} Badge={Badge} className="size-[17px]" badgeClassName="-top-1 bottom-auto" />
          {state === 'on' && attention === 0 && <span className={cn(MARK_BADGE, 'size-2.5 bg-emerald-500')} />}
          {attention > 0 && (
            <span
              className={cn(
                MARK_BADGE,
                'grid size-3.5 place-items-center bg-amber-500 text-[9px] font-bold leading-none text-white',
              )}
              data-testid="attached-channel-attention"
            >
              !
            </span>
          )}
          {count > 1 && (
            <span
              className="absolute -start-1 -top-1 min-w-4 rounded-full border-2 border-background bg-muted px-1 text-[9px] font-semibold tabular-nums leading-3 text-foreground"
              data-testid="attached-channel-count"
            >
              {count}
            </span>
          )}
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-72 p-0">
        <ChannelList
          title={`${title} · ${stateLabel}`}
          sources={group.sources}
          specFor={specFor(spec)}
          onDelete={onDelete}
        />
      </HoverCardContent>
    </HoverCard>
  );
}

/** A channel still to connect: the greyed glyph with a "+" where an attached mark carries its
 *  status dot. Pressing it opens the add dialog on that channel; hovering says what it is for. */
function ChannelOfferMark({ offer, onConnect }: { offer: ChannelOffer; onConnect: () => void }) {
  const { t } = useLingui();
  const Glyph = lucideByName(offer.iconName);
  const { label } = offer;
  return (
    <HoverCard {...MARK_HOVER}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={onConnect}
          aria-label={t`Connect ${label}`}
          className={cn(
            MARK,
            MARK_GREYED,
            'border-transparent bg-muted/50 hover:[&>:first-child]:opacity-100 hover:[&>:first-child]:grayscale-0',
          )}
          data-testid="channel-offer"
          data-channel={offer.key}
        >
          <Glyph className="size-[17px]" />
          <span className={cn(MARK_BADGE, 'grid size-3.5 place-items-center bg-muted-foreground text-background')}>
            <Plus className="size-2.5" strokeWidth={3} />
          </span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-64 space-y-2 p-3 text-[13px]">
        <div>{t`Get your ${label} messages here, and answer them from Flowpad.`}</div>
        <Button size="sm" onClick={onConnect} data-testid="channel-offer-connect">
          {t`Connect ${label}`}
        </Button>
      </HoverCardContent>
    </HoverCard>
  );
}

/** The channels still to connect, as the empty list offers them: one button each, and the add
 *  dialog it opens. Draws nothing when there is none to offer. */
export function ConnectChannelPrompt({ owner, offers }: { owner: TypeId; offers: ChannelOffer[] }) {
  const { t } = useLingui();
  const [initial, setInitial] = useState<DataDriver | null>(null);
  if (offers.length === 0) return null;
  return (
    <div className="flex flex-col items-center gap-2" data-testid="connect-channel-prompt">
      <span className="text-sm text-foreground">{t`Get your messages here`}</span>
      <div className="flex flex-wrap justify-center gap-2">
        {offers.map((offer) => {
          const Glyph = lucideByName(offer.iconName);
          const { label } = offer;
          return (
            <Button
              key={offer.key}
              variant="outline"
              size="sm"
              onClick={() => setInitial(offer.spec)}
              data-testid="connect-channel"
              data-channel={offer.key}
            >
              <Glyph className="me-1.5 size-3.5" />
              {t`Connect ${label}`}
            </Button>
          );
        })}
      </div>
      {initial && <AddChannelDialog owner={owner} initial={initial} onClose={() => setInitial(null)} />}
    </div>
  );
}

/** The one list every channel panel shows: a header, a `ChannelRow` per source, an
 *  optional footer. The hover card scopes it to one kind, the popover and the
 *  agent page's Channels tab to all. */
export function ChannelList({
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
      <div className="px-3 pb-1 pt-2.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {sources.map((source) => (
        <ChannelRow key={source.id} source={source} spec={specFor(source.provider)} onDelete={() => onDelete(source)} />
      ))}
      {sources.length === 0 && (
        <div className="px-3 py-2 text-xs text-muted-foreground">{t`No channel is attached yet.`}</div>
      )}
      {footer}
    </>
  );
}

/** A spec already in hand, as the lookup `ChannelList` expects. */
const specFor =
  (spec: DataDriver | undefined): SpecFor =>
  () =>
    spec;

/** One line of a channel list: glyph, name, why it is not delivering, the on/off
 *  switch and a delete. For a row a person must act on, the reason IS the control —
 *  pressing it runs the verb that recovers that kind (`ATTENTION[kind].verb`); a source in
 *  setup reads "Setup required" and pressing it opens its Setup. */
function ChannelRow({
  source,
  spec,
  onDelete,
}: {
  source: DataSource;
  spec: DataDriver | undefined;
  onDelete: () => void;
}) {
  const { t } = useLingui();
  const { toggle, busy } = useSourceToggle(source);
  const { verify, busy: verifying } = useSourceVerify(source);
  const { pull, pulling } = useSourcePull(source);
  const { Base, Badge } = sourceGlyphs(spec, source.channel);
  const attention = attentionReason(source);
  const state = markOf(attention);
  // The words stay the foreground colour (coloured text on a dark theme does not read); the strip
  // above the list says the same thing at full width. A paused row needs no line: its switch says it.
  const flagged = attention && state === 'parked' ? attention : null;
  const recover = {
    setup: { label: t`Setup`, run: () => openSourceSetup(source), busy: false },
    verify: { label: t`Verify`, run: verify, busy: verifying },
    resume: { label: t`Resume`, run: toggle, busy },
    pull: { label: t`Pull`, run: pull, busy: pulling },
  }[flagged ? ATTENTION[flagged.kind].verb : 'verify'];
  return (
    <div
      className="flex items-center gap-2.5 px-3 py-2 text-[13px]"
      data-testid="attached-channel-row"
      data-provider={source.provider}
    >
      <IconWithBadge Base={Base} Badge={Badge} className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{source.name || source.provider}</span>
        {/* Which account it is — the connected phone, the mailbox address. */}
        {source.account_key && (
          <span className="block truncate text-[11px] text-muted-foreground" data-testid="attached-channel-account">
            {source.account_key}
          </span>
        )}
        {flagged && (
          <button
            type="button"
            onClick={() => void recover.run()}
            disabled={recover.busy}
            title={`${recover.label}: ${attentionText(flagged)}`}
            className="block w-full truncate text-left text-[11px] underline decoration-dotted underline-offset-2 hover:decoration-solid disabled:opacity-60"
            data-testid="attached-channel-verify"
          >
            {attentionHeadline(flagged)}
          </button>
        )}
      </span>
      <Switch
        checked={state !== 'off'}
        aria-busy={busy || undefined}
        onClick={(e) => e.stopPropagation()}
        onCheckedChange={() => void toggle()}
        aria-label={t`Listen on ${source.name || source.provider}`}
        data-testid="attached-channel-switch"
      />
      {/* Pull is offered only where it can work: a listening source past setup (as the sources menu gates it). */}
      {state !== 'off' && !source.needsSetup && (
        <button
          type="button"
          onClick={() => void pull()}
          disabled={pulling}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
          aria-label={t`Pull changes now from ${source.name || source.provider}`}
          title={t`Pull changes now`}
          data-testid="attached-channel-pull"
        >
          <RefreshCw className={cn('size-3.5', pulling && 'animate-spin')} />
        </button>
      )}
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

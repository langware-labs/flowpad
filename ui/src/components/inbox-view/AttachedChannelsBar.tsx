/**
 * The attached channels of ONE owner — the local user's inbox or an agent's —
 * on the inbox's header line, as a row of round marks with a status dot
 * (presence-row pattern): green dot = listening, dashed ring = paused, "!" =
 * parked. ONE mark per provider: several sources of one kind share a mark
 * that carries their count, and hovering it lists just those sources with
 * their switches. Clicking a mark FILTERS the list to that provider's
 * sources; while a filter is on, the two controls give way to one × that
 * shows everything again.
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
import { useMemo, useState } from 'react';
import { DataSource, type DataSourceSpec, TypeId, User } from '@sdk';
import { Plus, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useContext } from '@src/hooks/useContext';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@src/components/ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Switch } from '@src/components/ui/switch';
import { DataSourceDialog } from '@src/components/data-sources/DataSourceDialog';
import { sourceIcon } from '@src/components/data-sources/source-icon';
import { isMessageSourceSpec, sourcesQuery, useSourceSpecs } from '@src/components/data-sources/use-source-specs';
import { useSourceToggle } from '@src/components/data-sources/use-source-toggle';
import { ownerOf } from './channel-owner';

const EMPTY: DataSource[] = [];

/** The owner's message sources, in a stable order — plus the spec lookup the
 *  caller needs to draw them, so a mount holds ONE specs subscription. Exported
 *  so a mount can ask "does this owner have any channel at all" from the same
 *  rows the line shows. */
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

type ChannelState = 'on' | 'off' | 'parked';
const stateOf = (s: DataSource): ChannelState => (s.needsAttention ? 'parked' : s.status === 'disabled' ? 'off' : 'on');

/** Sources of one provider, sharing a mark. Its state is the best of its
 *  members' — one listening source lights the mark; parked beats paused. */
interface ChannelGroup {
  provider: string;
  sources: DataSource[];
  state: ChannelState;
}
export function groupByProvider(rows: DataSource[]): ChannelGroup[] {
  const groups = new Map<string, DataSource[]>();
  for (const s of rows) groups.set(s.provider, [...(groups.get(s.provider) ?? []), s]);
  return [...groups.entries()]
    .map(([provider, sources]) => {
      const states = sources.map(stateOf);
      const state: ChannelState = states.includes('on') ? 'on' : states.includes('parked') ? 'parked' : 'off';
      return { provider, sources, state };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

interface Props {
  owner: TypeId;
  /** Source ids the list is filtered to; empty = everything. Owned by the
   *  list, since the list is what it narrows. */
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
  className?: string;
}

export function AttachedChannelsBar({ owner, selected, onSelectedChange, className }: Props) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { rows, specFor } = useAttachedChannels(owner);
  const [addOpen, setAddOpen] = useState(false);
  const [deleting, setDeleting] = useState<DataSource | null>(null);
  const filtering = selected.size > 0;
  const groups = useMemo(() => groupByProvider(rows), [rows]);

  /** A mark toggles ALL of its provider's sources in the filter. */
  const pick = (group: ChannelGroup) => {
    const next = new Set(selected);
    const ids = group.sources.map((s) => s.id);
    if (ids.every((id) => next.has(id))) ids.forEach((id) => next.delete(id));
    else ids.forEach((id) => next.add(id));
    onSelectedChange(next);
  };
  const remove = async (source: DataSource) => {
    try {
      await source.delete();
      if (selected.has(source.id)) {
        const next = new Set(selected);
        next.delete(source.id);
        onSelectedChange(next);
      }
    } catch (error) {
      notify.error({
        title: t`Could not remove ${source.name || source.provider}`,
        message: errorMessage(error, t`The source was not removed.`),
      });
    }
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
          key={group.provider}
          group={group}
          spec={specFor(group.provider)}
          dimmed={filtering && !group.sources.some((s) => selected.has(s.id))}
          pressed={filtering && group.sources.every((s) => selected.has(s.id))}
          onClick={() => pick(group)}
          onDelete={setDeleting}
        />
      ))}
      {filtering ? (
        <Button
          variant="ghost"
          size="icon"
          className={CONTROL}
          onClick={() => onSelectedChange(new Set())}
          aria-label={t`Show all channels`}
          data-testid="attached-channels-clear"
        >
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
              <div className="px-3 pb-1 pt-2.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{t`Channels`}</div>
              {rows.map((source) => (
                <ChannelRow key={source.id} source={source} spec={specFor(source.provider)} onDelete={() => setDeleting(source)} />
              ))}
              {rows.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">{t`No channel is attached yet.`}</div>}
              <button
                type="button"
                className="w-full border-t border-border/60 px-3 py-2 text-start text-xs text-primary hover:bg-accent"
                onClick={() => navigation.openTab(ViewType.DATA_SOURCES)}
                data-testid="attached-channels-see-all"
              >
                {t`See all sources`}
              </button>
            </PopoverContent>
          </Popover>
        </>
      )}
      {addOpen && <DataSourceDialog open onOpenChange={setAddOpen} owner={owner} only={isMessageSourceSpec} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(next) => !next && setDeleting(null)}
        variant="destructive"
        title={t`Remove this source?`}
        description={t`"${deleting?.name || deleting?.provider || ''}" will be removed along with its streams and every record it ingested. This cannot be undone.`}
        confirmLabel={t`Remove`}
        onConfirm={() => deleting && void remove(deleting)}
      />
    </div>
  );
}

const CONTROL = 'size-7 shrink-0 rounded-full text-muted-foreground';

/** One round mark per provider: the brand glyph, a status dot, a count when
 *  several sources share it, and — while filtering — a ring on the ones the
 *  list is narrowed to. Hovering lists just this provider's sources with
 *  their switches, the same rows the details popover shows for all. */
function ChannelMark({
  group,
  spec,
  dimmed,
  pressed,
  onClick,
  onDelete,
}: {
  group: ChannelGroup;
  spec: DataSourceSpec | undefined;
  dimmed: boolean;
  pressed: boolean;
  onClick: () => void;
  onDelete: (source: DataSource) => void;
}) {
  const { t } = useLingui();
  const Icon = sourceIcon(spec, group.sources[0].channel);
  const { state } = group;
  const count = group.sources.length;
  const name = count === 1 ? group.sources[0].name || group.provider : `${spec?.title || group.provider} × ${count}`;
  const stateLabel = state === 'parked' ? t`needs attention` : state === 'on' ? t`listening` : t`paused`;
  return (
    <HoverCard openDelay={150} closeDelay={120}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-pressed={pressed}
          aria-label={`${name} · ${stateLabel}`}
          className={cn(
            'relative grid size-8 shrink-0 place-items-center rounded-full border-[1.5px] bg-background transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            state === 'off' ? 'border-dashed border-border' : 'border-border',
            pressed && 'border-primary ring-1 ring-primary',
            (dimmed || state === 'off') && '[&>svg]:opacity-45 [&>svg]:grayscale',
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
        <div className="px-3 pb-1 pt-2.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {spec?.title || group.provider} · {stateLabel}
        </div>
        {group.sources.map((source) => (
          <ChannelRow key={source.id} source={source} spec={spec} onDelete={() => onDelete(source)} />
        ))}
      </HoverCardContent>
    </HoverCard>
  );
}

/** One line of the details popover: glyph, name, its setup note, the on/off
 *  switch and a delete. */
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
        {state === 'parked' && <span className="block truncate text-[11px] text-amber-500">{source.setup_detail || t`Finish setup, then press Verify.`}</span>}
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

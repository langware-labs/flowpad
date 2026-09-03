/**
 * The attached channels of ONE owner — the local user's inbox or an agent's —
 * as chips on the inbox's header line: a chip means the channel is ON
 * (listening), its × turns it off, and "+" lists the channels that are off so
 * one can be turned back on. That is the whole control: present or absent.
 *
 * One component, two mounts, no knowledge of which owner it serves. Its rows
 * are exactly `DataSource.find_owned(owner)` ∩ MessageSource — the same
 * `sources` query the Data Sources screen and the inbox chip already share —
 * filtered by `owner` and by the spec's `sends`. The spec, not the row's
 * `channel`: a just-attached source has no channel until its first poll, and
 * the chip must be there the moment it is created.
 *
 * On and off are the ONE pause/resume verb (`useSourceToggle`). A parked chip
 * (`needsAttention`) wears a warning that opens Data Sources — the backend
 * refuses to poll it until someone finishes its setup. Attaching a channel is
 * not here either: that is the Data Sources screen's job.
 */
import { useMemo } from 'react';
import { DataSource, type DataSourceSpec, TypeId, User } from '@sdk';
import { CircleAlert, Plus, X } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useContext } from '@src/hooks/useContext';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { cn } from '@src/lib/utils';
import { Button } from '@src/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { sourceIcon } from '@src/components/data-sources/source-icon';
import { isMessageSourceSpec, sourcesQuery, useSourceSpecs } from '@src/components/data-sources/use-source-specs';
import { useSourceToggle } from '@src/components/data-sources/use-source-toggle';
import { ownerOf } from './channel-owner';

const EMPTY: DataSource[] = [];

/** The owner's message sources, in a stable order — plus the spec lookup the
 *  caller needs to draw them, so a mount holds ONE specs subscription. Exported
 *  so a mount can ask "does this owner have any channel at all" from the same
 *  rows the bar shows. */
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

const isOff = (source: DataSource) => source.status === 'disabled';

export function AttachedChannelsBar({ owner, className }: { owner: TypeId; className?: string }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { rows, specFor } = useAttachedChannels(owner);
  const on = rows.filter((s) => !isOff(s));
  const off = rows.filter(isOff);
  const openDataSources = () => navigation.openTab(ViewType.DATA_SOURCES);

  return (
    <div
      className={cn('flex min-w-0 items-center gap-1.5 overflow-hidden', className)}
      data-testid="attached-channels"
      data-owner={owner.toString()}
      role="toolbar"
      aria-label={t`Attached channels`}
    >
      {on.map((source) => (
        <ChannelChip key={source.id} source={source} spec={specFor(source.provider)} onParked={openDataSources} />
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 rounded-full text-muted-foreground"
            aria-label={t`Turn a channel on`}
            data-testid="attached-channels-add"
          >
            <Plus />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          {off.map((source) => (
            <OffChannelItem key={source.id} source={source} spec={specFor(source.provider)} />
          ))}
          {off.length === 0 && <DropdownMenuItem disabled>{t`Every attached channel is on`}</DropdownMenuItem>}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={openDataSources}>{t`Attach a channel in Data Sources…`}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ChannelChip({ source, spec, onParked }: { source: DataSource; spec: DataSourceSpec | undefined; onParked: () => void }) {
  const { t } = useLingui();
  const { toggle, busy } = useSourceToggle(source);
  const Icon = sourceIcon(spec, source.channel);
  const name = source.name || source.provider;
  const parked = source.needsAttention;
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-full border bg-background ps-1.5 pe-0.5 text-xs',
        parked ? 'border-amber-500/60' : 'border-border',
      )}
      data-testid="attached-channel"
      data-provider={source.provider}
      data-status={source.status}
      data-state={parked ? 'parked' : 'on'}
    >
      <Icon className="size-4 shrink-0" />
      <span className="max-w-40 truncate">{name}</span>
      {parked && (
        <button
          type="button"
          onClick={onParked}
          className="rounded-full p-0.5 text-amber-500 hover:bg-accent"
          aria-label={t`${name} needs attention — open Data Sources`}
          title={t`Needs attention`}
          data-testid="attached-channel-fix"
        >
          <CircleAlert className="size-3.5" />
        </button>
      )}
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        aria-label={t`Turn ${name} off`}
        data-testid="attached-channel-remove"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

/** A channel that is off, offered under "+": picking it turns it back on. */
function OffChannelItem({ source, spec }: { source: DataSource; spec: DataSourceSpec | undefined }) {
  const { toggle, busy } = useSourceToggle(source);
  const Icon = sourceIcon(spec, source.channel);
  return (
    <DropdownMenuItem onSelect={() => void toggle()} disabled={busy} data-testid="attached-channel-off" data-provider={source.provider}>
      <Icon className="size-4" />
      <span className="truncate">{source.name || source.provider}</span>
    </DropdownMenuItem>
  );
}

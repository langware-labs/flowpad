import type { ComputeNode } from '@sdk';
import { Button } from '@src/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { ViewType } from '@sdk';
import { Loader2, Pin, PinOff, Plus } from 'lucide-react';
import { useCallback } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type { OpenerDescriptor, OpenerId } from './tab_opener_types';
import { usePinnedOpeners } from './usePinnedOpeners';

interface Props {
  openers: OpenerDescriptor[];
  isTabCreationPending: boolean;
}

function dockerNodeName(node: ComputeNode): string {
  return (node as { uname?: string }).uname?.replace(/^docker-/, '') ?? node.id;
}

/** Small "!" sub-icon overlaid on an opener whose capability check failed. */
function OpenerWarningBadge({ openerId }: { openerId: OpenerId }) {
  return (
    <span
      className="absolute -right-0.5 -top-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-amber-500 text-[9px] font-bold leading-none text-black"
      data-testid={`opener-warning-${openerId}`}
      aria-hidden="true"
    >
      !
    </span>
  );
}

export function getInlineOpeners(
  openers: OpenerDescriptor[],
  pinned: OpenerId[],
  lastOpened: OpenerId | null,
): OpenerDescriptor[] {
  const byId = new Map(openers.map((o) => [o.id, o]));
  const pinnedInOrder = pinned.map((id) => byId.get(id)).filter((o): o is OpenerDescriptor => !!o && o.available);
  const recentOpener = lastOpened && !pinned.includes(lastOpened) ? byId.get(lastOpened) : null;
  return recentOpener?.available ? [...pinnedInOrder, recentOpener] : pinnedInOrder;
}

export function TerminalOpenerToolbar({ openers, isTabCreationPending }: Props) {
  const { t } = useLingui();
  const { pinned, lastOpened, isPinned, togglePin, rememberOpened } = usePinnedOpeners();
  const { navigation } = useDockNavigation();

  const availableOpeners = openers.filter((o) => o.available);
  const inlineOpeners = getInlineOpeners(openers, pinned, lastOpened);

  const activate = useCallback(
    (opener: OpenerDescriptor, dockerNode?: ComputeNode) => {
      // A warned opener (capability check failed) can't launch — route to the
      // Capabilities screen (check/install) instead of creating a doomed tab.
      // Single enforcement point for inline buttons and menu rows alike.
      // The opener's own kind rides along so the view re-probes THAT capability
      // on arrival: the warning may be stale (discovery only sweeps at backend
      // start, so a CLI installed since then still reads as missing).
      if (opener.warning) {
        navigation.openTab(ViewType.CAPABILITIES, {
          ...(opener.capabilityKind ? { capabilityKind: opener.capabilityKind } : {}),
        });
        return;
      }
      rememberOpened(opener.id);
      if (opener.id === 'docker' && dockerNode && opener.onDockerNodeSelect) {
        opener.onDockerNodeSelect(dockerNode);
      } else {
        opener.onActivate();
      }
    },
    [navigation, rememberOpened],
  );

  const renderInline = (opener: OpenerDescriptor) => {
    const Icon = opener.Icon;
    const showSpinner = opener.pendingInline;
    const disabled = opener.disabled || isTabCreationPending;
    const iconNode = showSpinner ? (
      <Loader2 className="h-4 w-4 animate-spin" />
    ) : (
      <>
        <Icon className={`h-4 w-4 ${opener.iconClassName ?? ''}`} />
        {opener.warning && <OpenerWarningBadge openerId={opener.id} />}
      </>
    );

    if (opener.id === 'docker' && opener.dockerNodes && opener.dockerNodes.length > 1) {
      return (
        <DropdownMenu key={opener.id}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              className="h-7 w-7 rounded"
              disabled={disabled}
              aria-label={t`Open docker terminal`}
              title={t`Open docker terminal`}
              data-testid="open-docker-tab-button"
            >
              {iconNode}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {opener.dockerNodes.map((dn) => {
              const name = dockerNodeName(dn);
              return (
                <DropdownMenuItem
                  key={dn.id}
                  onSelect={() => activate(opener, dn)}
                  data-testid={`open-docker-tab-button-${name}`}
                >
                  {name}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }

    const onClick =
      opener.id === 'docker' && opener.dockerNodes && opener.dockerNodes.length === 1
        ? () => activate(opener, opener.dockerNodes![0])
        : () => activate(opener);

    const testId =
      opener.id === 'docker' && opener.dockerNodes && opener.dockerNodes.length === 1
        ? `open-docker-tab-button-${dockerNodeName(opener.dockerNodes[0])}`
        : opener.id === 'sandbox'
          ? 'open-sandbox-tab-button'
          : opener.id === 'terminal'
            ? 'open-terminal-tab-button'
            : `opener-inline-${opener.id}`;

    const title = opener.warning ? `${opener.label} — ${opener.warning}` : opener.label;

    return (
      <Button
        key={opener.id}
        variant="secondary"
        size="icon"
        className="relative h-7 w-7 rounded"
        onClick={onClick}
        disabled={disabled}
        aria-label={title}
        title={title}
        data-testid={testId}
      >
        {iconNode}
      </Button>
    );
  };

  const renderMenuRow = (opener: OpenerDescriptor) => {
    const Icon = opener.Icon;
    const pinned = isPinned(opener.id);
    const PinIcon = pinned ? Pin : PinOff;

    const pinButton = (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          togglePin(opener.id);
        }}
        className="ms-auto inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        aria-label={pinned ? t`Unpin ${opener.label}` : t`Pin ${opener.label}`}
        title={pinned ? t`Unpin` : t`Pin`}
        data-testid={`opener-pin-toggle-${opener.id}`}
        data-state={pinned ? 'pinned' : 'unpinned'}
      >
        <PinIcon className={`h-3.5 w-3.5 ${pinned ? 'text-foreground' : ''}`} />
      </button>
    );

    if (opener.id === 'docker' && opener.dockerNodes && opener.dockerNodes.length > 1) {
      return (
        <DropdownMenuSub key={opener.id}>
          <DropdownMenuSubTrigger className="gap-2 pe-1" data-testid={`opener-menu-row-${opener.id}`}>
            <Icon className={`h-4 w-4 ${opener.iconClassName ?? ''}`} />
            <span>{opener.label}</span>
            {pinButton}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {opener.dockerNodes.map((dn) => {
              const name = dockerNodeName(dn);
              return (
                <DropdownMenuItem
                  key={dn.id}
                  onSelect={() => activate(opener, dn)}
                  data-testid={`opener-menu-docker-${name}`}
                >
                  {name}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      );
    }

    const onSelect =
      opener.id === 'docker' && opener.dockerNodes && opener.dockerNodes.length === 1
        ? () => activate(opener, opener.dockerNodes![0])
        : () => activate(opener);

    return (
      <DropdownMenuItem
        key={opener.id}
        onSelect={onSelect}
        disabled={opener.disabled}
        className="gap-2 pe-1"
        data-testid={`opener-menu-row-${opener.id}`}
        title={opener.warning ?? undefined}
      >
        <span className="relative inline-flex">
          <Icon className={`h-4 w-4 ${opener.iconClassName ?? ''}`} />
          {opener.warning && <OpenerWarningBadge openerId={opener.id} />}
        </span>
        <span>{opener.label}</span>
        {pinButton}
      </DropdownMenuItem>
    );
  };

  return (
    <div className="flex shrink-0 items-center gap-1 border-s px-1" data-testid="terminal-tab-end-toolbar">
      {inlineOpeners.map(renderInline)}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded"
            aria-label={t`Open new tab menu`}
            title={t`New tab`}
            data-testid="opener-plus-button"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[14rem]">
          {availableOpeners.map(renderMenuRow)}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

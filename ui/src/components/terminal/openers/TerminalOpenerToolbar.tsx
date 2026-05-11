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
import { Loader2, Pin, PinOff, Plus } from 'lucide-react';
import { useCallback } from 'react';
import type { OpenerDescriptor, OpenerId } from './tab_opener_types';
import { usePinnedOpeners } from './usePinnedOpeners';

interface Props {
  openers: OpenerDescriptor[];
  isTabCreationPending: boolean;
}

function dockerNodeName(node: ComputeNode): string {
  return (node as { uname?: string }).uname?.replace(/^docker-/, '') ?? node.id;
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
  const { pinned, lastOpened, isPinned, togglePin, rememberOpened } = usePinnedOpeners();

  const availableOpeners = openers.filter((o) => o.available);
  const inlineOpeners = getInlineOpeners(openers, pinned, lastOpened);

  const activate = useCallback(
    (opener: OpenerDescriptor, dockerNode?: ComputeNode) => {
      rememberOpened(opener.id);
      if (opener.id === 'docker' && dockerNode && opener.onDockerNodeSelect) {
        opener.onDockerNodeSelect(dockerNode);
      } else {
        opener.onActivate();
      }
    },
    [rememberOpened],
  );

  const renderInline = (opener: OpenerDescriptor) => {
    const Icon = opener.Icon;
    const showSpinner = opener.pendingInline;
    const disabled = opener.disabled || isTabCreationPending;
    const iconNode = showSpinner ? (
      <Loader2 className="h-4 w-4 animate-spin" />
    ) : (
      <Icon className={`h-4 w-4 ${opener.iconClassName ?? ''}`} />
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
              aria-label="Open docker terminal"
              title="Open docker terminal"
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

    return (
      <Button
        key={opener.id}
        variant="secondary"
        size="icon"
        className="h-7 w-7 rounded"
        onClick={onClick}
        disabled={disabled}
        aria-label={opener.label}
        title={opener.label}
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
        className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        aria-label={pinned ? `Unpin ${opener.label}` : `Pin ${opener.label}`}
        title={pinned ? 'Unpin' : 'Pin'}
        data-testid={`opener-pin-toggle-${opener.id}`}
        data-state={pinned ? 'pinned' : 'unpinned'}
      >
        <PinIcon className={`h-3.5 w-3.5 ${pinned ? 'text-foreground' : ''}`} />
      </button>
    );

    if (opener.id === 'docker' && opener.dockerNodes && opener.dockerNodes.length > 1) {
      return (
        <DropdownMenuSub key={opener.id}>
          <DropdownMenuSubTrigger className="gap-2 pr-1" data-testid={`opener-menu-row-${opener.id}`}>
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
        className="gap-2 pr-1"
        data-testid={`opener-menu-row-${opener.id}`}
      >
        <Icon className={`h-4 w-4 ${opener.iconClassName ?? ''}`} />
        <span>{opener.label}</span>
        {pinButton}
      </DropdownMenuItem>
    );
  };

  return (
    <div className="flex shrink-0 items-center gap-1 border-l px-1" data-testid="terminal-tab-end-toolbar">
      {inlineOpeners.map(renderInline)}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded"
            aria-label="Open new tab menu"
            title="New tab"
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

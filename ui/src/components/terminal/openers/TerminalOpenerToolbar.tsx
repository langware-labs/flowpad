import { Button } from '@src/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { ViewType } from '@sdk';
import { Loader2, Pin, PinOff, Plus } from 'lucide-react';
import { useCallback } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type { ViewMode } from '@src/contexts/view-mode-context';
import { MODE_LABELS } from '@src/components/view-mode/mode-vocabulary';
import { rememberLaunch } from './last-launch';
import type { OpenerDescriptor, OpenerId } from './tab_opener_types';
import { OpenerWarningBadge } from './OpenerWarningBadge';
import { usePinnedOpeners } from './usePinnedOpeners';

interface Props {
  openers: OpenerDescriptor[];
  isTabCreationPending: boolean;
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
  const { pinned, lastOpened, lastMode, isPinned, togglePin } = usePinnedOpeners();
  const { navigation } = useDockNavigation();

  const availableOpeners = openers.filter((o) => o.available);
  const inlineOpeners = getInlineOpeners(openers, pinned, lastOpened);

  const activate = useCallback(
    (opener: OpenerDescriptor, mode?: ViewMode) => {
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
      // The worker launch chain re-records with the shape it actually opened in.
      rememberLaunch(opener.id, mode ?? null);
      if (mode && opener.launchIn) opener.launchIn(mode);
      else opener.onActivate();
    },
    [navigation],
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
        {opener.warning && <OpenerWarningBadge id={opener.id} />}
      </>
    );

    // The slot that is the last launch is "another like the last one" and
    // carries that launch's shape; a pinned slot that is also the last launch
    // is the same one button, so it follows too.
    const quickMode = opener.id === lastOpened && lastMode ? lastMode : undefined;
    const onClick = () => activate(opener, quickMode);

    const testId =
      opener.id === 'sandbox'
        ? 'open-sandbox-tab-button'
        : opener.id === 'terminal'
          ? 'open-terminal-tab-button'
          : `opener-inline-${opener.id}`;

    const baseLabel = quickMode ? `${opener.label} (${MODE_LABELS[quickMode]})` : opener.label;
    const title = opener.warning ? `${baseLabel} — ${opener.warning}` : baseLabel;

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

    const onSelect = () => activate(opener);

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
          {opener.warning && <OpenerWarningBadge id={opener.id} />}
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
            className="h-7 w-7 rounded-md border border-foreground/30"
            aria-label={t`Open new tab menu`}
            title={t`New tab`}
            data-testid="opener-plus-button"
          >
            <Plus className="h-5 w-5" strokeWidth={2.75} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[14rem]">
          {availableOpeners.map(renderMenuRow)}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

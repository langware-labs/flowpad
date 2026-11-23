import { useEffect, useRef, useState, type RefObject } from 'react';
import { Cast, Menu } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { GraphContext, type TypeId } from '@sdk';
import {
  attentionEntityActionClassName,
  chromeEntityActionClassName,
} from '@src/components/entity-actions/action-button-styles';
import { ContextMenuButton, contextMenuAvailable } from '@src/components/entity-actions/ContextMenuButton';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import {
  RemoteControlPanel,
  RemoteControlTimeLeft,
  useRemoteControl,
} from '@src/components/remote-control/RemoteControlPanel';
import { Button } from '@src/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { Popover, PopoverAnchor, PopoverContent } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { REMOTE_CONTROL_ASSERTION_PARAM, REMOTE_CONTROL_PARAM } from '@src/navigation/DockPointer';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { useCurrentDock, useDockNavigation } from '@src/navigation/useDockNavigation';
import { RecordScreenMenuItem } from './RecordScreenButton';

const DETAIL = 'shrink-0 text-[11px] text-muted-foreground';

/**
 * The bar's last button: the actions that do not earn a button of their own — Record screen,
 * Context (when the bar addresses something that has one) and Remote control.
 *
 * Context opens the SAME list the entity headers' Context button opens, hung off this button.
 * Remote control opens its panel (`RemoteControlPanel`) the same way, under this button; a dock
 * carrying `remote-control=open` opens it on arrival, and one carrying `remote-control-assertion`
 * (the fingerprint answer the hub page hands back) is given to the machine first — that is what
 * turns remote control on. It is a machine setting, absent on the hub.
 */
export function TopBarMoreMenu({
  contextTypeId,
  contextTitle,
}: {
  contextTypeId: TypeId | null;
  contextTitle?: string;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [remoteControlOpen, setRemoteControlOpen] = useState(false);
  // Set by a row that opens a popover. The popover opens only AFTER the menu has closed (`onCloseAutoFocus`):
  // opened while the menu is still closing, the menu's own dismissal reads as a click outside the popover and
  // closes it at once.
  const openingPopover = useRef<'context' | 'remote-control' | null>(null);
  const showContext = !!contextTypeId && contextMenuAvailable();
  const ContextIcon = iconForType(GraphContext.type);
  const label = t`More`;

  const showRemoteControl = !isHubOnly();
  const remoteControl = useRemoteControl();
  const { status, reload } = remoteControl;
  // The menu row and the bar's icon say "on" / "off" from the machine's own state (a local call, never the hub):
  // read here when the bar mounts, and again by the menu's `onOpenChange` each time it opens.
  useEffect(() => {
    if (showRemoteControl) void reload();
  }, [showRemoteControl, reload]);

  // A link that asks for the panel (`remote-control=open`), with or without the fingerprint answer that turns
  // remote control on (`remote-control-assertion`): act once, and take both options off the address with ONE
  // history replace — Back, a reload or a restored tab must not hand the answer in again.
  const dock = useCurrentDock();
  const asked = dock?.remoteControlOpen === true;
  const assertion = dock?.remoteControlAssertion ?? null;
  const handedIn = useRef<string | null>(null);
  useEffect(() => {
    if (!asked && !assertion) return;
    if (showRemoteControl) {
      if (assertion && handedIn.current !== assertion) {
        handedIn.current = assertion;
        // The panel opens once the machine answered: opening reads the status, and that read must come after.
        void remoteControl.confirm(assertion).finally(() => setRemoteControlOpen(true));
      } else if (!assertion) {
        setRemoteControlOpen(true);
      }
    }
    navigation.replaceDock(
      navigation.here.withOption(REMOTE_CONTROL_PARAM, null).withOption(REMOTE_CONTROL_ASSERTION_PARAM, null),
    );
    // On arrival only — not on every new `navigation` / `remoteControl` identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, assertion]);

  return (
    <>
      {/* While this machine can be controlled remotely, the bar says so: a glowing icon, first in the row.
          A click opens the panel (the time left, Lock now). Gone the moment it is off again. */}
      {showRemoteControl && status?.available && status.on && (
        <Tooltip delayDuration={600}>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={`order-first ${attentionEntityActionClassName} h-8 w-8 [&_svg]:size-[18px]`}
              aria-label={t`Remote control is on`}
              onClick={() => setRemoteControlOpen(true)}
              data-testid="top-nav-remote-control"
              data-attention="true"
            >
              <Cast />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs" data-testid="top-nav-remote-control-tooltip">
            {status.open_until ? (
              <Trans>
                Remote control is on · <RemoteControlTimeLeft until={status.open_until} />
              </Trans>
            ) : (
              t`Remote control is on`
            )}
          </TooltipContent>
        </Tooltip>
      )}
      <DropdownMenu
        onOpenChange={(open) => {
          if (open && showRemoteControl) void reload();
        }}
      >
        <Tooltip delayDuration={1500}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                ref={triggerRef}
                type="button"
                variant="ghost"
                size="icon"
                className={chromeEntityActionClassName}
                aria-label={label}
                data-testid="top-nav-more"
              >
                <Menu />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {label}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="end"
          className="min-w-52"
          onCloseAutoFocus={(e) => {
            const which = openingPopover.current;
            if (!which) return;
            openingPopover.current = null;
            // The menu must not take focus back to its button either: that too would close the popover.
            e.preventDefault();
            requestAnimationFrame(() => (which === 'context' ? setContextOpen(true) : setRemoteControlOpen(true)));
          }}
        >
          <RecordScreenMenuItem />
          {showContext && (
            <DropdownMenuItem
              className="gap-2"
              onSelect={() => {
                openingPopover.current = 'context';
              }}
              data-testid="top-nav-more-context"
            >
              <ContextIcon className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{t`Context`}</span>
            </DropdownMenuItem>
          )}
          {showRemoteControl && (
            <DropdownMenuItem
              className="gap-2"
              onSelect={() => {
                openingPopover.current = 'remote-control';
              }}
              data-testid="top-nav-more-remote-control"
            >
              <Cast className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{t`Remote control`}</span>
              {status?.available && (
                <span className={DETAIL} data-testid="top-nav-more-remote-control-state">
                  {status.on ? t`on` : t`off`}
                </span>
              )}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {showContext && contextTypeId && (
        <ContextMenuButton
          typeId={contextTypeId}
          title={contextTitle}
          open={contextOpen}
          onOpenChange={setContextOpen}
          anchorRef={triggerRef}
        />
      )}
      {showRemoteControl && (
        <Popover open={remoteControlOpen} onOpenChange={setRemoteControlOpen}>
          <PopoverAnchor virtualRef={triggerRef as RefObject<HTMLElement>} />
          <PopoverContent align="end" className="w-[22rem] p-2 text-xs" data-testid="top-nav-remote-control-panel">
            <RemoteControlPanel control={remoteControl} />
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

import { useLingui } from '@lingui/react/macro';
import { ProcessKind } from '@sdk';
import { MessageSquare } from 'lucide-react';
import React, { createContext, useContext, useLayoutEffect, useMemo, useState } from 'react';
import { useInRouterContext } from 'react-router';
import { useProcessesForTarget } from '@src/components/entity-execution-panel/hooks/useProcessesForTarget';
import { Button } from '@src/components/ui/button';
import { contentAssetTargetForDock, offersDocChat } from '@src/navigation/content-asset-dock';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

interface SlotState {
  available: boolean;
  /** Chats about the doc on screen — read once per viewer, here, not per toggle. */
  count: number;
  claim: () => () => void;
}

const SlotContext = createContext<SlotState | null>(null);

/**
 * The viewer's Chat toggle — the ONE in/out control for "chat with this doc".
 * Off: `navigation.enterChat` (resumes the last chat about the doc, in the doc's
 * project, the active one, or no project). On: `navigation.leaveChat` (the plain
 * doc; the chat keeps running). The badge counts the chats about this doc.
 */
function ViewerChatToggle({ count }: { count: number }) {
  const { t } = useLingui();
  const { currentDock, navigation } = useDockNavigation();
  const [busy, setBusy] = useState(false);
  if (!currentDock) return null;

  const on = !!currentDock.hostProcessId;
  const label = on ? t`Close chat` : t`Chat about this file`;
  const onClick = () => {
    if (on) {
      navigation.leaveChat(currentDock);
      return;
    }
    if (busy) return;
    setBusy(true);
    void navigation.enterChat(currentDock).finally(() => setBusy(false));
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      title={label}
      aria-label={label}
      aria-pressed={on}
      disabled={busy}
      onClick={onClick}
      data-testid="viewer-chat-toggle"
      data-active={on ? 'true' : 'false'}
      className={`relative h-7 gap-1 px-1.5 ${on ? 'bg-primary/15 text-primary' : 'text-muted-foreground'}`}
    >
      <MessageSquare className="h-3.5 w-3.5" />
      {count > 0 && (
        <span className="text-[10px] tabular-nums" data-testid="viewer-chat-count">
          {count}
        </span>
      )}
    </Button>
  );
}

/** True when the viewer on screen offers "chat with this doc". False outside an
 *  asset viewer (`ViewerChatSlotProvider`), so a header rendered alone stays as it was. */
export function useViewerChatAvailable(): boolean {
  return useContext(SlotContext)?.available ?? false;
}

/** Where a viewer's header puts the Chat toggle (its trailing actions). Claims the
 *  slot, so `ViewerChatSlotProvider` does not draw its fallback strip as well. */
export function ViewerChatSlot() {
  const ctx = useContext(SlotContext);
  const available = !!ctx?.available;
  useLayoutEffect(() => (available ? ctx?.claim() : undefined), [ctx, available]);
  return available && ctx ? <ViewerChatToggle count={ctx.count} /> : null;
}

/**
 * Wraps every asset viewer (mounted once, in `AssetEditorRouter`). A viewer with
 * a header renders `<ViewerChatSlot/>` in it; a viewer without one gets the toggle
 * in a thin right-aligned strip above it, so every viewer has the control.
 * Outside a router (an editor rendered on its own) there is no dock, so no toggle.
 */
export function ViewerChatSlotProvider({ children }: { children: React.ReactNode }) {
  return useInRouterContext() ? <RoutedSlotProvider>{children}</RoutedSlotProvider> : <>{children}</>;
}

function RoutedSlotProvider({ children }: { children: React.ReactNode }) {
  const [claims, setClaims] = useState(0);
  const { currentDock, windowMode } = useDockNavigation();
  const available = !!currentDock && !windowMode && offersDocChat(currentDock);
  const target = available ? contentAssetTargetForDock(currentDock)?.targetVfsPath : undefined;
  const { processes } = useProcessesForTarget(target, { enabled: available, processType: ProcessKind.Chat });
  const count = processes.length;
  const claim = useMemo(
    () => () => {
      setClaims((n) => n + 1);
      return () => setClaims((n) => n - 1);
    },
    [],
  );
  const value = useMemo(() => ({ available, count, claim }), [available, count, claim]);
  return (
    <SlotContext.Provider value={value}>
      <div className="flex h-full min-h-0 flex-col">
        {available && claims === 0 && (
          <div className="flex h-8 flex-shrink-0 items-center justify-end border-b px-2" data-testid="viewer-chat-strip">
            <ViewerChatToggle count={count} />
          </div>
        )}
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </SlotContext.Provider>
  );
}

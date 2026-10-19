import type { ShowTarget } from '@sdk';
import { type ReactNode, useCallback, useMemo } from 'react';
import { t } from '@lingui/core/macro';
import { AgenticProcess } from '@sdk';
import { DisplayToolbar } from '@src/components/display-toolbar';
import { notify } from '@src/notifications/notify';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DisplayHistoryButton } from './display-history-button';
import { displayHistory, historyEntryDock, projectIdFromDock } from './display-stack';
import {displayAnnotationContextForDock} from './display-annotation';

import { submitDisplayAnnotation } from './display-annotation-submit';

/**
 * The workspace chrome around whatever the display is currently showing.
 *
 * It exists because the display is an ADDRESS now, and an address can be rendered by
 * either workspace surface: `AssetVibeWorkspace` owns content-asset docks,
 * `VibeWorkspace` owns everything else. Both need the same three affordances, and
 * before this they lived inside the pane's own viewer switch — so promoting or
 * browsing history worked or not depending on which component happened to claim the
 * URL.
 *
 * All three are workspace-level, not viewer-level:
 *
 * - **history** belongs to the process (`display_stack`), not to the thing on
 *   screen, so it stays reachable no matter what is displayed;
 * - **promote** is offered ONLY for the active display, the one replaceable row — a
 *   durable child the user opened is already its own tab;
 * - **annotate** uploads into the chat's input dir and prompts the process, which is
 *   exactly why it cannot live inside a viewer.
 *
 * Rendering only: the history merge and the promotion address live in
 * `display-stack.ts`, the annotation pipeline in `display-annotation-submit.ts`.
 */
export interface DisplayChromeProps {
  /** The workspace's process — owner of the history stack and the chat. */
  process: AgenticProcess | null;
  /** The newest `flow show` payload, covering a stack that has not caught up. */
  latestShown?: ShowTarget | null;
  /**
   * Whether this content is the workspace's DISPLAY (vibe) rather than a plain
   * document at its own address (standard). Inactive keeps the wrapper mounted but
   * strips the chrome — see `DisplayToolbar.hideStrip` for why it is not simply
   * "don't render me".
   */
  active?: boolean;
  children: ReactNode;
}

export function DisplayChrome({ process, latestShown, active = true, children }: DisplayChromeProps) {
  const { currentDock, navigation } = useDockNavigation();

  const stack = useMemo(() => displayHistory(process?.displayStack ?? [], latestShown), [process, latestShown]);

  const openHistoryEntry = useCallback(
    (entry: ShowTarget) => {
      const dock = historyEntryDock(entry, projectIdFromDock(currentDock));
      if (dock) navigation.openDock(dock);
    },
    [currentDock, navigation],
  );

  const historySlot = <DisplayHistoryButton stack={stack} onOpen={openHistoryEntry} />;

  /** Promote the active display to a durable tab: the same address, minus the marker. */
  const promote = useCallback(() => {
    if (currentDock) navigation.openDock(currentDock.withActiveDisplay(false));
  }, [currentDock, navigation]);

  const annotate = useCallback(
    async (target: HTMLElement) => {
      try {
        if (!process) throw new Error('No active Vibe session');
        const submitted = await submitDisplayAnnotation(process, target, displayAnnotationContextForDock(currentDock));
        if (submitted) notify.success({ title: t`Annotation submitted` });
      } catch (err) {
        notify.error({
          title: t`Could not annotate view`,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [currentDock, process],
  );

  return (
    <DisplayToolbar
      // One switch: a hidden strip is neither clickable nor focusable, so the
      // slots below do not need a second `active` gate of their own.
      hideStrip={!active}
      onOpenInTab={currentDock?.isActiveDisplay ? promote : undefined}
      onAnnotate={(target) => void annotate(target)}
      historySlot={historySlot}
    >
      {children}
    </DisplayToolbar>
  );
}

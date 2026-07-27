import { useCallback } from 'react';

import { PrefKey } from '@sdk';
import { usePreference } from '@src/hooks/use-preference';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

export type AgentTraceTab = 'stack' | 'details';

const URL_PARAM = 'traceTab';

function isTab(v: string | undefined | null): v is AgentTraceTab {
  return v === 'stack' || v === 'details';
}

/**
 * Active-tab state for the AgentTrace viewer, persisted in the dock pointer —
 * same pattern as `useTranscriptMode` (`?transcriptMode`) and the workflow
 * editor's `?editorMode`. Precedence: URL `?traceTab` → stored preference → 'stack'.
 *
 * Setting the tab pushes a new DockPointer with the option merged in (URL-first:
 * the click only navigates; the URL is the single source of truth), so the tab
 * is shareable + back-button-restorable.
 */
export function useAgentTraceTab() {
  const { navigation, currentDock } = useDockNavigation();
  const urlTab = currentDock?.options?.[URL_PARAM];
  const [storedTab, setStoredTab] = usePreference<string>(PrefKey.AGENT_TRACE_TAB);
  const tab: AgentTraceTab = isTab(urlTab) ? urlTab : isTab(storedTab) ? storedTab : 'stack';

  const setTab = useCallback(
    (t: AgentTraceTab) => {
      setStoredTab(t);
      if (currentDock) {
        const nextOptions = { ...(currentDock.options ?? {}), [URL_PARAM]: t };
        navigation.openDock(
          new DockPointer(currentDock.viewType, currentDock.pointer, nextOptions, currentDock.layout),
        );
      }
    },
    [currentDock, navigation, setStoredTab],
  );

  return [tab, setTab] as const;
}

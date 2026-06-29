import { useCallback, useState } from 'react';

import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

export type AgentTraceTab = 'stack' | 'details';

const STORAGE_KEY = 'agent-trace-tab';
const URL_PARAM = 'traceTab';
const DEFAULT_TAB: AgentTraceTab = 'stack';

function isTab(v: string | undefined | null): v is AgentTraceTab {
  return v === 'stack' || v === 'details';
}

function readStored(): AgentTraceTab {
  if (typeof window === 'undefined') return DEFAULT_TAB;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isTab(raw) ? raw : DEFAULT_TAB;
  } catch {
    return DEFAULT_TAB;
  }
}

/**
 * Active-tab state for the AgentTrace viewer, persisted in the dock pointer —
 * same pattern as `useTranscriptMode` (`?transcriptMode`) and the workflow
 * editor's `?editorMode`. Precedence: URL `?traceTab` → localStorage → 'stack'.
 *
 * Setting the tab pushes a new DockPointer with the option merged in (URL-first:
 * the click only navigates; the URL is the single source of truth), so the tab
 * is shareable + back-button-restorable.
 */
export function useAgentTraceTab() {
  const { navigation, currentDock } = useDockNavigation();
  const urlTab = currentDock?.options?.[URL_PARAM];
  const [localTab, setLocalTab] = useState<AgentTraceTab>(readStored);
  const tab: AgentTraceTab = isTab(urlTab) ? urlTab : localTab;

  const setTab = useCallback(
    (t: AgentTraceTab) => {
      setLocalTab(t);
      try {
        localStorage.setItem(STORAGE_KEY, t);
      } catch {
        /* storage may be disabled */
      }
      if (currentDock) {
        const nextOptions = { ...(currentDock.options ?? {}), [URL_PARAM]: t };
        navigation.openDock(
          new DockPointer(currentDock.viewType, currentDock.pointer, nextOptions, currentDock.layout),
        );
      }
    },
    [currentDock, navigation],
  );

  return [tab, setTab] as const;
}

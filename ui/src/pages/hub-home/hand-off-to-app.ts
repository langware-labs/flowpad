import { useState } from 'react';
import type { DockPointer } from '@src/navigation/DockPointer';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useOpenInFlowpad } from '@src/pages/entry/useOpenFlowpad';

/**
 * Send the person to `dock` in the Flowpad app. Inside the app that is a navigation; on the hub it is the
 * `flowpad://` hand-off, and `noApp` says no app answered it (for this address — a new one starts clean).
 */
export function useHandOffToApp(dock: DockPointer): { handOff: () => Promise<void>; noApp: boolean } {
  const { navigation } = useDockNavigation();
  const path = dock.toUrl();
  const openInFlowpad = useOpenInFlowpad(path);
  const [unanswered, setUnanswered] = useState<string | null>(null);

  const handOff = async () => {
    if (!isHubOnly()) {
      navigation.openDock(dock);
      return;
    }
    setUnanswered((await openInFlowpad()) ? null : path);
  };

  return { handOff, noApp: unanswered === path };
}

/** A machine's name as a sentence says it: without the leading "@"; '' when there is none. */
export function displayMachineName(name: string | null | undefined): string {
  return (name || '').replace(/^@/, '');
}

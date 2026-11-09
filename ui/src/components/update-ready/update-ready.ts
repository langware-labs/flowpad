import { useEffect, useState } from 'react';

/**
 * The ONE ready update set the desktop reports (electron/main.js updateReadyState): downloaded, prepared and
 * checked — the desktop (restarts FlowPad; the engine riding it follows the new desktop) or the engine alone
 * (swapped without restarting the desktop). The "Update Ready" toast, the top bar's indicator and the version
 * popover all show this one state.
 */
export interface UpdateReadyState {
  ready: boolean;
  restart: boolean;
  desktop: { from: string; to: string } | null;
  engine: { from: string | null; to: string } | null;
}

export interface UpdateReadyApi {
  getUpdateReadyInfo?: () => Promise<UpdateReadyState>;
  /** "Restart": applies the ready set through the desktop's existing update paths. */
  activateUpdate?: () => Promise<{ started: boolean; reason?: string; success?: boolean; error?: string }>;
  onUpdateReadyState?: (callback: (state: UpdateReadyState) => void) => () => void;
  onUpdateReadyToast?: (callback: (state: UpdateReadyState) => void) => () => void;
}

export function getUpdateReadyApi(): UpdateReadyApi | undefined {
  return (window as unknown as { electronAPI?: UpdateReadyApi }).electronAPI;
}

/** Asks the version popover (in the footer) to open — the top bar's indicator has no popover of its own. */
export const OPEN_VERSION_POPOVER_EVENT = 'flowpad:open-version-popover';

/** The ready set, kept current by the desktop's pushes; null in a browser (no desktop updater). */
export function useUpdateReady(): UpdateReadyState | null {
  const [state, setState] = useState<UpdateReadyState | null>(null);
  useEffect(() => {
    const api = getUpdateReadyApi();
    if (!api?.getUpdateReadyInfo) return;
    let live = true;
    api
      .getUpdateReadyInfo()
      .then((s) => {
        if (live) setState(s);
      })
      .catch(() => {
        /* an older desktop: no ready state */
      });
    const dispose = api.onUpdateReadyState?.((s) => {
      if (live) setState(s);
    });
    return () => {
      live = false;
      dispose?.();
    };
  }, []);
  return state;
}

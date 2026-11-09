import { useEffect, useState } from 'react';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

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

/** What "Restart" answered (main.js activateUpdate): not started (`busy`, `not-ready`, a failed apply), or an engine install's result. */
export interface ActivationResult {
  started: boolean;
  reason?: string;
  success?: boolean;
  error?: string;
}

export interface UpdateReadyApi {
  getUpdateReadyInfo?: () => Promise<UpdateReadyState>;
  /** "Restart": applies the ready set through the desktop's existing update paths. */
  activateUpdate?: () => Promise<ActivationResult>;
  /** The toast the desktop asked for and the UI has not shown yet — taken once (null when none). */
  takeUpdateReadyToast?: () => Promise<UpdateReadyState | null>;
  onUpdateReadyState?: (callback: (state: UpdateReadyState) => void) => () => void;
  onUpdateReadyToast?: (callback: (state: UpdateReadyState) => void) => () => void;
}

export function getUpdateReadyApi(): UpdateReadyApi | undefined {
  return (window as unknown as { electronAPI?: UpdateReadyApi }).electronAPI;
}

/** Asks the version popover (in the footer) to open — the top bar's indicator has no popover of its own. */
export const OPEN_VERSION_POPOVER_EVENT = 'flowpad:open-version-popover';

/** With `activation`: a "Restart" from the toast that did not apply — the popover says why. */
export interface OpenVersionPopoverDetail {
  activation?: ActivationResult;
}

export function openVersionPopover(detail: OpenVersionPopoverDetail = {}): void {
  window.dispatchEvent(new CustomEvent<OpenVersionPopoverDetail>(OPEN_VERSION_POPOVER_EVENT, { detail }));
}

/** True when "Restart" did not apply the update (the toast is already closed: the popover has to say so). */
export function activationFailed(r: ActivationResult): boolean {
  return !r.started || r.success === false;
}

/**
 * Why "Restart" did not apply the update, or null when it did — one wording for the popover's buttons and for a
 * "Restart" from the toast (already closed, so the popover opens to say it).
 */
export function activationProblem(r: ActivationResult): MessageDescriptor | null {
  if (!activationFailed(r)) return null;
  const error = r.error;
  if (r.reason === 'busy') return msg`Another update is in progress. Try again when it is done.`;
  if (r.reason === 'not-ready' || r.reason === 'not-downloaded')
    return msg`This update is no longer ready to install. FlowPad offers it again once it is.`;
  if (r.success === false) return error ? msg`Install failed: ${error}` : msg`Install failed.`;
  if (error) return msg`The update could not be applied: ${error}`;
  return msg`The update could not be applied. Try again.`;
}

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

/**
 * Open a URL in the user's real browser. Uses the Electron bridge when
 * present (desktop app) so the link leaves the app shell; falls back to
 * `window.open` in the browser build. Shared by every "open a sign-in /
 * external page" surface (device-flow modals, footers).
 */
export function openExternal(url: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const electronAPI = (window as any).electronAPI;
  if (electronAPI?.openExternal) {
    void electronAPI.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** What the desktop updater can offer right now (electron/main.js desktopUpdateInfo). */
export interface DesktopUpdateInfo {
  supported: boolean;
  version: string | null;
  state: 'idle' | 'downloading' | 'ready';
  percent: number | null;
  error: string | null;
  busy: boolean;
}

export type DesktopUpdateAction =
  | { kind: 'download'; version: string | null }
  | { kind: 'downloading'; percent: number }
  | { kind: 'install'; version: string | null };

/**
 * The version popover's desktop button: download the newer desktop, its progress, or restart into the downloaded
 * one (also one postponed with "Later"). Nothing when the updater cannot update this build (dev, Microsoft Store),
 * or neither the updater nor GitHub knows a newer desktop — the GitHub row can be ahead of the updater's last
 * check, and the download looks at the feed itself.
 */
export function desktopUpdateAction(
  info: DesktopUpdateInfo | null,
  githubUpdateAvailable: boolean,
): DesktopUpdateAction | null {
  if (!info?.supported) return null;
  if (info.state === 'ready') return { kind: 'install', version: info.version };
  if (info.state === 'downloading') return { kind: 'downloading', percent: info.percent ?? 0 };
  if (!info.version && !githubUpdateAvailable) return null;
  return { kind: 'download', version: info.version };
}

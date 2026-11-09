/** What the desktop updater can offer right now (electron/main.js desktopUpdateInfo). */
export interface DesktopUpdateInfo {
  supported: boolean;
  version: string | null;
  state: 'idle' | 'downloading' | 'ready';
  percent: number | null;
  error: string | null;
  busy: boolean;
}

/** Is `candidate` a newer `x.y.z` than `installed`? (A leading `v` is ignored; garbage is never newer.) */
export function isNewerVersion(installed: string | null | undefined, candidate: string | null | undefined): boolean {
  const parse = (v: string | null | undefined) =>
    /^v?(\d+)\.(\d+)\.(\d+)$/i
      .exec((v ?? '').trim())
      ?.slice(1)
      .map(Number);
  const a = parse(installed);
  const b = parse(candidate);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] > a[i];
  return false;
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

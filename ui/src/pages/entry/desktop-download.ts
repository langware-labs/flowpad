/**
 * Which FlowPad Desktop installer fits the visitor's computer, and how to start its
 * download without leaving the page. Pure — no i18n, no React — so the platform
 * matrix is testable on its own; `DesktopDownload.tsx` puts words on it.
 */

/** The GitHub Releases `latest` assets. The names are fixed by `electron/electron-builder.json`
 *  (`${productName}-${arch}.${ext}`, nsis `${productName}-Setup.${ext}`) and the website links
 *  to them, so they do not move between releases. */
const RELEASE_BASE = 'https://github.com/langware-labs/flowpad/releases/latest/download/';

export type InstallerId = 'dmg' | 'exe' | 'appimage' | 'deb' | 'rpm';

export const INSTALLERS: Record<InstallerId, { url: string; os: DesktopOs }> = {
  dmg: { url: `${RELEASE_BASE}Flowpad-universal.dmg`, os: 'mac' },
  exe: { url: `${RELEASE_BASE}Flowpad-Setup.exe`, os: 'windows' },
  appimage: { url: `${RELEASE_BASE}Flowpad-x86_64.AppImage`, os: 'linux' },
  deb: { url: `${RELEASE_BASE}Flowpad-amd64.deb`, os: 'linux' },
  rpm: { url: `${RELEASE_BASE}Flowpad-x86_64.rpm`, os: 'linux' },
};

/** Every installer, in the order a manual "other platforms" list shows them. */
export const ALL_INSTALLERS: InstallerId[] = ['dmg', 'exe', 'appimage', 'deb', 'rpm'];

/** `other` = a computer FlowPad Desktop does not run on (phone, tablet, ChromeOS) or one we
 *  could not recognise. */
export type DesktopOs = 'mac' | 'windows' | 'linux' | 'other';
/** `x86` = 32-bit Intel. `unknown` is never guessed into `x64`. */
export type CpuArch = 'x64' | 'arm' | 'x86' | 'unknown';

export interface Platform {
  os: DesktopOs;
  arch: CpuArch;
}

/** What the browser told us. `uaPlatform`/`uaArch`/`uaBitness` are the User-Agent Client Hints
 *  (Chromium only); `touchPoints` tells an iPad (which reports a Mac UA) from a Mac. */
export interface PlatformHints {
  userAgent: string;
  uaPlatform?: string;
  uaArch?: string;
  uaBitness?: string;
  touchPoints?: number;
}

function osFrom(hints: PlatformHints): DesktopOs {
  const p = (hints.uaPlatform ?? '').toLowerCase();
  if (p === 'macos') return 'mac';
  if (p === 'windows') return 'windows';
  if (p === 'linux') return 'linux';
  if (p) return 'other'; // Android, Chrome OS, iOS, Fuchsia…

  const ua = hints.userAgent;
  if (/iPhone|iPad|iPod|Android|CrOS/i.test(ua)) return 'other';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return (hints.touchPoints ?? 0) > 1 ? 'other' : 'mac';
  if (/Linux/i.test(ua)) return 'linux';
  return 'other';
}

function archFrom(hints: PlatformHints, os: DesktopOs): CpuArch {
  if (hints.uaArch) {
    const arch = hints.uaArch.toLowerCase();
    if (arch === 'arm') return 'arm';
    if (arch === 'x86') return hints.uaBitness === '32' ? 'x86' : hints.uaBitness === '64' ? 'x64' : 'unknown';
    return 'unknown';
  }
  const ua = hints.userAgent;
  if (/aarch64|arm64|\barmv?\d/i.test(ua)) return 'arm';
  if (/x86_64|x86-64|amd64|Win64|WOW64|\bx64\b/i.test(ua)) return 'x64';
  if (/\bi[3-6]86\b/i.test(ua)) return 'x86';
  // Windows browsers name a 64-bit OS (Win64, WOW64, ARM64); a bare "Windows NT" is 32-bit Windows.
  if (os === 'windows' && /Windows NT/i.test(ua)) return 'x86';
  return 'unknown';
}

export function platformFromHints(hints: PlatformHints): Platform {
  const os = osFrom(hints);
  return { os, arch: os === 'other' ? 'unknown' : archFrom(hints, os) };
}

/**
 * What to offer a platform: `installers` (the first is the default), plus `note`:
 * - `arm-emulated` — Windows on ARM: the x64 installer runs under the OS's emulation;
 * - `x64-only` — Linux of unknown architecture: offered, but labelled x86_64-only;
 * - `no-arch` — Linux on ARM, or 32-bit Linux or Windows: there is no installer to give;
 * - `no-os` — not a desktop FlowPad runs on.
 */
export type OfferNote = 'arm-emulated' | 'x64-only' | 'no-arch' | 'no-os';

export interface Offer {
  installers: InstallerId[];
  note?: OfferNote;
}

export function offerFor(platform: Platform): Offer {
  switch (platform.os) {
    case 'mac':
      return { installers: ['dmg'] }; // universal: Intel and Apple Silicon
    case 'windows':
      if (platform.arch === 'x86') return { installers: [], note: 'no-arch' }; // the installer is x64-only
      return platform.arch === 'arm' ? { installers: ['exe'], note: 'arm-emulated' } : { installers: ['exe'] };
    case 'linux':
      if (platform.arch === 'x64') return { installers: ['appimage', 'deb', 'rpm'] };
      if (platform.arch === 'unknown') return { installers: ['appimage', 'deb', 'rpm'], note: 'x64-only' };
      return { installers: [], note: 'no-arch' };
    default:
      return { installers: [], note: 'no-os' };
  }
}

type UaData = {
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; bitness?: string }>;
};

/** This browser's platform. The high-entropy hints are asked for once and are best-effort: a
 *  browser without them (Safari, Firefox) or one that refuses falls back to the UA string. */
export async function detectPlatform(): Promise<Platform> {
  const nav = navigator as Navigator & { userAgentData?: UaData };
  const hints: PlatformHints = {
    userAgent: nav.userAgent,
    uaPlatform: nav.userAgentData?.platform || undefined,
    touchPoints: nav.maxTouchPoints,
  };
  try {
    const high = await nav.userAgentData?.getHighEntropyValues?.(['architecture', 'bitness']);
    hints.uaArch = high?.architecture || undefined;
    hints.uaBitness = high?.bitness || undefined;
  } catch {
    // Refused: the UA string decides.
  }
  return platformFromHints(hints);
}

const DOWNLOAD_FRAME_ID = 'flowpad-download-frame';

/**
 * Start a download in a hidden iframe instead of navigating the page. GitHub answers with an
 * attachment, so the browser saves it; a missing asset (GitHub's 404 page) or any other
 * non-download answer lands in the invisible frame — the page itself never goes anywhere.
 * A plain `<a href>` would leave the page on a 404, and `download` is ignored cross-origin.
 * One frame, reused: each click points it at the new file.
 */
export function startDownload(url: string): void {
  let frame = document.getElementById(DOWNLOAD_FRAME_ID) as HTMLIFrameElement | null;
  if (!frame) {
    frame = document.createElement('iframe');
    frame.id = DOWNLOAD_FRAME_ID;
    frame.style.display = 'none';
    frame.setAttribute('aria-hidden', 'true');
    document.body.appendChild(frame);
  }
  frame.src = url;
}

/** The last installer this tab started downloading — so a reload still says "once FlowPad is
 *  installed, open it". It records an attempt, never an installation. */
const ATTEMPT_KEY = 'flowpad.desktop-download-attempt';

export function readDownloadAttempt(): InstallerId | null {
  try {
    const id = sessionStorage.getItem(ATTEMPT_KEY);
    return id && id in INSTALLERS ? (id as InstallerId) : null;
  } catch {
    return null;
  }
}

export function writeDownloadAttempt(id: InstallerId | null): void {
  try {
    if (id) sessionStorage.setItem(ATTEMPT_KEY, id);
    else sessionStorage.removeItem(ATTEMPT_KEY);
  } catch {
    // Storage blocked: the state lasts for this page view only.
  }
}

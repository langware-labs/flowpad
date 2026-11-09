/**
 * Which FlowPad installer a visitor is offered, from what their browser says about the
 * computer — and that a download never moves the page.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  INSTALLERS,
  offerFor,
  platformFromHints,
  readDownloadAttempt,
  startDownload,
  writeDownloadAttempt,
} from '@src/pages/entry/desktop-download';

const UA = {
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  winChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  winArmFirefox: 'Mozilla/5.0 (Windows NT 10.0; ARM64; rv:132.0) Gecko/20100101 Firefox/132.0',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
  linuxArmFirefox: 'Mozilla/5.0 (X11; Linux aarch64; rv:132.0) Gecko/20100101 Firefox/132.0',
  linuxBare: 'Mozilla/5.0 (X11; Linux) Gecko/20100101 Firefox/132.0',
  linux32: 'Mozilla/5.0 (X11; Linux i686; rv:132.0) Gecko/20100101 Firefox/132.0',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  chromeos:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

const offered = (hints: Parameters<typeof platformFromHints>[0]) => offerFor(platformFromHints(hints));

describe('the installer offered', () => {
  it.each([
    ['macOS (Intel UA — also what Apple Silicon Safari sends)', { userAgent: UA.macSafari }, ['dmg'], undefined],
    [
      'macOS on Apple Silicon (client hints)',
      { userAgent: UA.macSafari, uaPlatform: 'macOS', uaArch: 'arm' },
      ['dmg'],
      undefined,
    ],
    ['Windows x64', { userAgent: UA.winChrome }, ['exe'], undefined],
    ['Windows on ARM (UA)', { userAgent: UA.winArmFirefox }, ['exe'], 'arm-emulated'],
    // Chromium freezes the UA at "Win64; x64" — the client hint is what tells ARM apart.
    [
      'Windows on ARM (client hints)',
      { userAgent: UA.winChrome, uaPlatform: 'Windows', uaArch: 'arm', uaBitness: '64' },
      ['exe'],
      'arm-emulated',
    ],
    ['Linux x86_64', { userAgent: UA.linuxFirefox }, ['appimage', 'deb', 'rpm'], undefined],
    ['Linux on ARM', { userAgent: UA.linuxArmFirefox }, [], 'no-arch'],
    [
      'Linux on ARM behind a frozen x86_64 UA',
      { userAgent: UA.linuxFirefox, uaPlatform: 'Linux', uaArch: 'arm' },
      [],
      'no-arch',
    ],
    ['32-bit Linux', { userAgent: UA.linux32 }, [], 'no-arch'],
    [
      'Linux of unknown architecture is not assumed x86_64',
      { userAgent: UA.linuxBare },
      ['appimage', 'deb', 'rpm'],
      'x64-only',
    ],
    ['iPhone', { userAgent: UA.iphone }, [], 'no-os'],
    ['iPad (reports a Mac UA, has touch)', { userAgent: UA.macSafari, touchPoints: 5 }, [], 'no-os'],
    ['Android', { userAgent: UA.android }, [], 'no-os'],
    ['ChromeOS', { userAgent: UA.chromeos }, [], 'no-os'],
    ['ChromeOS (client hints)', { userAgent: UA.chromeos, uaPlatform: 'Chrome OS' }, [], 'no-os'],
    ['nothing recognisable', { userAgent: '' }, [], 'no-os'],
  ])('%s', (_name, hints, installers, note) => {
    expect(offered(hints)).toEqual(note ? { installers, note } : { installers });
  });

  it('points at the GitHub release assets', () => {
    const base = 'https://github.com/langware-labs/flowpad/releases/latest/download/';
    expect(Object.fromEntries(Object.entries(INSTALLERS).map(([id, i]) => [id, i.url]))).toEqual({
      dmg: `${base}Flowpad-universal.dmg`,
      exe: `${base}Flowpad-Setup.exe`,
      appimage: `${base}Flowpad-x86_64.AppImage`,
      deb: `${base}Flowpad-amd64.deb`,
      rpm: `${base}Flowpad-x86_64.rpm`,
    });
  });
});

describe('downloading in place', () => {
  // The unit tier shares one jsdom document across files: start from a clean one.
  beforeEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
  });

  it('starts every download in one hidden frame, never navigating the page', () => {
    const before = window.location.href;
    startDownload(INSTALLERS.dmg.url);
    startDownload(INSTALLERS.exe.url);
    const frames = document.querySelectorAll('iframe#flowpad-download-frame');
    expect(frames).toHaveLength(1);
    expect(frames[0].src).toBe(INSTALLERS.exe.url);
    expect(frames[0].style.display).toBe('none');
    expect(window.location.href).toBe(before);
  });

  it('remembers the attempt for the tab, and ignores a value it did not write', () => {
    expect(readDownloadAttempt()).toBeNull();
    writeDownloadAttempt('deb');
    expect(readDownloadAttempt()).toBe('deb');
    sessionStorage.setItem('flowpad.desktop-download-attempt', 'zip');
    expect(readDownloadAttempt()).toBeNull();
    writeDownloadAttempt(null);
    expect(readDownloadAttempt()).toBeNull();
  });
});

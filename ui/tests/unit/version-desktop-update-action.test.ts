import { describe, expect, it } from 'vitest';
import { desktopUpdateAction, type DesktopUpdateInfo } from '@src/components/version-popover/desktop-update-action';

const info = (o: Partial<DesktopUpdateInfo> = {}): DesktopUpdateInfo => ({
  supported: true,
  version: null,
  state: 'idle',
  percent: null,
  error: null,
  busy: false,
  ...o,
});

// The popover's desktop button: download, its progress, or restart into the downloaded update.
describe('desktopUpdateAction', () => {
  it('a newer desktop the updater knows: download it', () => {
    expect(desktopUpdateAction(info({ version: '0.2.81' }), false)).toEqual({ kind: 'download', version: '0.2.81' });
  });
  it('only GitHub knows one yet: download (the download looks at the feed itself)', () => {
    expect(desktopUpdateAction(info(), true)).toEqual({ kind: 'download', version: null });
  });
  it('downloading: its progress', () => {
    expect(desktopUpdateAction(info({ version: '0.2.81', state: 'downloading', percent: 45 }), true)).toEqual({
      kind: 'downloading',
      percent: 45,
    });
    expect(desktopUpdateAction(info({ state: 'downloading' }), false)).toEqual({ kind: 'downloading', percent: 0 });
  });
  it('downloaded — also one postponed with "Later": restart into it', () => {
    expect(desktopUpdateAction(info({ version: '0.2.81', state: 'ready' }), false)).toEqual({
      kind: 'install',
      version: '0.2.81',
    });
  });
  it('up to date, or a build the updater does not update: no button', () => {
    expect(desktopUpdateAction(info(), false)).toBeNull();
    expect(desktopUpdateAction(info({ supported: false, version: '0.2.81' }), true)).toBeNull();
    expect(desktopUpdateAction(null, true)).toBeNull();
  });
});

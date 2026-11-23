import { describe, expect, it } from 'vitest';
import type { BrowserDriverInfo, BrowserDriverState, BrowserStatus } from '@sdk';
import { chipState, extensionProfile, usable } from '@src/components/footer/BrowserChip';

const driver = (name: string, state: BrowserDriverState, managed = true): BrowserDriverInfo => ({
  name,
  title: name,
  icon: 'globe',
  description: '',
  managed,
  probe: managed ? 'cdp' : 'extension',
  tool_prefixes: [],
  install_url: '',
  state,
  setup: '',
  config: {},
});
const base: BrowserStatus = {
  setting: 'agent',
  pick: '',
  effective: 'agent',
  effective_kind: '',
  source: 'default',
  requested: '',
  worker: 'claude',
  drivers: [driver('agent', 'ready'), driver('extension', 'not_installed', false)],
  kinds: [],
  extension: { installed: false, device: '' },
  last_use: null,
};
const now = Date.parse('2026-11-15T12:00:00Z');
const use = (family: string, secondsAgo: number, failed = false) => ({
  family,
  tool: 'navigate',
  url: 'https://example.com',
  at: new Date(now - secondsAgo * 1000).toISOString(),
  failed,
});

describe('chipState', () => {
  it('idle with no call', () => expect(chipState(base, now)).toBe('idle'));
  it('live right after a call on its own browser', () => expect(chipState({ ...base, last_use: use('agent', 3) }, now)).toBe('live'));
  it('idle after a while', () => expect(chipState({ ...base, last_use: use('agent', 60) }, now)).toBe('idle'));
  it('dropped when the last call on the extension failed', () =>
    expect(chipState({ ...base, effective: 'extension', last_use: use('extension', 3, true) }, now)).toBe('dropped'));
  it('a call on another browser does not light it', () =>
    expect(chipState({ ...base, last_use: use('playwright', 3) }, now)).toBe('idle'));
});

describe('extensionProfile', () => {
  const profiles = [
    { browser: 'Google Chrome', name: 'Shlomo', email: null, installed: false },
    { browser: 'Google Chrome', name: 'Work', email: 'w@x.com', installed: true },
  ];
  it('names the profile the extension is in', () =>
    expect(extensionProfile({ ...base, extension: { installed: true, device: '', profiles } })).toBe('Work'));
  it('null when no profile has it (shown as "Profile not found")', () => expect(extensionProfile(base)).toBeNull());
});

describe('usable', () => {
  it('a driver this worker cannot use, or that is not installed, cannot be picked', () =>
    expect(base.drivers.map(usable)).toEqual([true, false]));
  it('a browser nobody proved connected yet can still be picked', () => expect(usable(driver('x', 'not_connected', false))).toBe(true));
});

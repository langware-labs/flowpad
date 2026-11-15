import { describe, expect, it } from 'vitest';
import type { BrowserStatus } from '@sdk';
import { chipState, extensionState } from '@src/components/footer/BrowserChip';

const base: BrowserStatus = {
  setting: 'agent',
  effective: 'agent',
  supports_extension: true,
  agent: { up: false, pid: null, port: null, browser: '' },
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

describe('extensionState', () => {
  it('not installed when Claude Code never saw it', () => expect(extensionState(base)).toBe('not_installed'));
  it('not connected when installed but unproven', () =>
    expect(extensionState({ ...base, extension: { installed: true, device: 'Browser 1' } })).toBe('not_connected'));
  it('connected once a session drove it', () =>
    expect(extensionState({ ...base, last_use: use('extension', 5) })).toBe('connected'));
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

import { ActionInfo } from '@sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProtocolUrl, fireDeepLink, LOCAL_API_PREFIX } from '../../src/pages/entry/useOpenFlowpad';

const MESSAGE_ID = '123e4567-e89b-4456-8abc-def123456789';

describe('MessageLanding deep-link constants', () => {
  it('pins the desktop api prefix', () => {
    // Must match API_PREFIX in ts_sdk/src/config/SDKConfig.ts (not re-exported via @sdk).
    expect(LOCAL_API_PREFIX).toBe('/api/v1');
  });
});

describe('open target path (ActionInfo)', () => {
  it('builds the open action url for a flow_message', () => {
    const openAction = new ActionInfo('open', 'flow_message', MESSAGE_ID, 'GET');
    const openTargetPath = `${LOCAL_API_PREFIX}${openAction.actionUrl}`;
    expect(openTargetPath).toBe(`/api/v1/graph/flow_message/${MESSAGE_ID}/open`);
  });
});

describe('buildProtocolUrl', () => {
  const openTargetPath = `/api/v1/graph/flow_message/${MESSAGE_ID}/open`;

  it('routes through login_callback with an api key', () => {
    const protocolUrl = buildProtocolUrl('sk-test-key', openTargetPath);
    const expectedQuery = new URLSearchParams({
      'flowpad-api-key': 'sk-test-key',
      next: openTargetPath,
    }).toString();
    expect(protocolUrl).toBe(`flowpad://auth/login_callback?${expectedQuery}`);
  });

  it('hits the target path directly without an api key', () => {
    const protocolUrl = buildProtocolUrl(null, openTargetPath);
    expect(protocolUrl).toBe(`flowpad://api/v1/graph/flow_message/${MESSAGE_ID}/open`);
  });

  it('url-encodes the api key and next path in the query', () => {
    const protocolUrl = buildProtocolUrl('k+e/y=', openTargetPath);
    const url = new URL(protocolUrl);
    expect(url.searchParams.get('flowpad-api-key')).toBe('k+e/y=');
    expect(url.searchParams.get('next')).toBe(openTargetPath);
  });
});

describe('fireDeepLink', () => {
  const url = 'flowpad://api/v1/graph/flow_message/x/open';
  let assigned: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    assigned = [];
    vi.stubGlobal('location', {
      set href(value: string) {
        assigned.push(value);
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports a hand-off when the page loses focus (browser prompt or app opening)', async () => {
    const result = fireDeepLink(url);
    expect(assigned).toEqual([url]);
    window.dispatchEvent(new Event('blur'));
    await expect(result).resolves.toBe(true);
  });

  it('reports nothing opened when no reaction comes and the page still has focus', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const result = fireDeepLink(url);
    await vi.advanceTimersByTimeAsync(1500);
    await expect(result).resolves.toBe(false);
  });

  it('counts a page that is unfocused when the window ends as handed off', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const result = fireDeepLink(url);
    await vi.advanceTimersByTimeAsync(1500);
    await expect(result).resolves.toBe(true);
  });
});

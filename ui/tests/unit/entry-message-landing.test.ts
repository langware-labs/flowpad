import { ActionInfo } from '@sdk';
import { describe, expect, it } from 'vitest';
import { buildOpenUrls, LOCAL_API_PREFIX, LOCAL_PORT, OPEN_IN_ELECTRON } from '../../src/pages/entry/useOpenFlowpad';

const MESSAGE_ID = '123e4567-e89b-4456-8abc-def123456789';

describe('MessageLanding deep-link constants', () => {
  it('pins the desktop backend port, api prefix, and protocol preference', () => {
    expect(LOCAL_PORT).toBe(9007);
    // Must match API_PREFIX in ts_sdk/src/config/SDKConfig.ts (not re-exported via @sdk).
    expect(LOCAL_API_PREFIX).toBe('/api/v1');
    expect(OPEN_IN_ELECTRON).toBe(true);
  });
});

describe('open target path (ActionInfo)', () => {
  it('builds the open action url for a flow_message', () => {
    const openAction = new ActionInfo('open', 'flow_message', MESSAGE_ID, 'GET');
    const openTargetPath = `${LOCAL_API_PREFIX}${openAction.actionUrl}`;
    expect(openTargetPath).toBe(`/api/v1/graph/flow_message/${MESSAGE_ID}/open`);
  });
});

describe('buildOpenUrls', () => {
  const openTargetPath = `/api/v1/graph/flow_message/${MESSAGE_ID}/open`;

  it('routes through login_callback with an api key', () => {
    const { localUrl, protocolUrl } = buildOpenUrls('sk-test-key', LOCAL_PORT, openTargetPath);
    const expectedQuery = new URLSearchParams({
      'flowpad-api-key': 'sk-test-key',
      next: openTargetPath,
    }).toString();
    expect(localUrl).toBe(`http://localhost:9007/auth/login_callback?${expectedQuery}`);
    expect(protocolUrl).toBe(`flowpad://auth/login_callback?${expectedQuery}`);
  });

  it('hits the target path directly without an api key', () => {
    const { localUrl, protocolUrl } = buildOpenUrls(null, LOCAL_PORT, openTargetPath);
    expect(localUrl).toBe(`http://localhost:9007${openTargetPath}`);
    expect(protocolUrl).toBe(`flowpad://api/v1/graph/flow_message/${MESSAGE_ID}/open`);
  });

  it('url-encodes the api key and next path in the query', () => {
    const { protocolUrl } = buildOpenUrls('k+e/y=', LOCAL_PORT, openTargetPath);
    const url = new URL(protocolUrl);
    expect(url.searchParams.get('flowpad-api-key')).toBe('k+e/y=');
    expect(url.searchParams.get('next')).toBe(openTargetPath);
  });
});

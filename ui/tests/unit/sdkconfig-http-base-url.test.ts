import { API_PREFIX, SDKConfig } from '@sdk/config/SDKConfig';
import type { ISDKConfig } from '@sdk/config/types';
import { afterEach, describe, expect, it } from 'vitest';

// X7: httpBaseUrl is the single axios base consumer. In local dev it must return
// the RELATIVE /api/v1 prefix so HTTP requests stay same-origin (Vite proxy) and
// skip the CORS preflight OPTIONS round-trip. Packaged/electron builds must keep
// the absolute serverUrl. serverUrl/wsUrl/apiUrl are untouched by this change.

function makeConfig(overrides: Partial<ISDKConfig> = {}): SDKConfig {
  const base: ISDKConfig = {
    api_protocol: 'http',
    api_host: 'localhost',
    api_port: 9008,
    deploy_env: 'local',
    auth_provider: 'custom',
    flowpad_app_host: 'flowpad.app',
    flowpad_app_port: undefined,
    sentry_dsn: '',
    sentry_project: '',
    check_refresh_token: false,
  };
  return new SDKConfig({ ...base, ...overrides });
}

describe('SDKConfig.httpBaseUrl (X7 same-origin dev base)', () => {
  afterEach(() => {
    delete (globalThis as { __FLOWPAD_API_URL__?: unknown }).__FLOWPAD_API_URL__;
  });

  it('returns the relative /api/v1 prefix in local-dev (localhost, no runtime override)', () => {
    const cfg = makeConfig();
    expect(cfg.httpBaseUrl).toBe(API_PREFIX);
    expect(cfg.httpBaseUrl).toBe('/api/v1');
    // serverUrl/wsUrl stay absolute and untouched
    expect(cfg.serverUrl).toBe('http://localhost:9008/api/v1');
    expect(cfg.wsUrl).toBe('ws://localhost:9008/api/v1/connect/ws');
  });

  it('returns the absolute serverUrl when packaged (non-local deploy_env)', () => {
    const cfg = makeConfig({ deploy_env: 'desktop' });
    expect(cfg.httpBaseUrl).toBe(cfg.serverUrl);
    expect(cfg.httpBaseUrl).toBe('http://localhost:9008/api/v1');
  });

  it('returns the absolute serverUrl when production', () => {
    const cfg = makeConfig({ deploy_env: 'production', api_host: 'api.flowpad.app', api_protocol: 'https', api_port: 443 });
    expect(cfg.httpBaseUrl).toBe(cfg.serverUrl);
    expect(cfg.httpBaseUrl).toBe('https://api.flowpad.app/api/v1');
  });

  it('returns the absolute serverUrl when a runtime backend override is pinned (electron/realm)', () => {
    (globalThis as { __FLOWPAD_API_URL__?: unknown }).__FLOWPAD_API_URL__ = 'http://localhost:9008';
    const cfg = makeConfig();
    expect(cfg.httpBaseUrl).toBe(cfg.serverUrl);
    expect(cfg.httpBaseUrl).toBe('http://localhost:9008/api/v1');
  });

  it('returns the absolute serverUrl when host is not localhost', () => {
    const cfg = makeConfig({ api_host: '127.0.0.1' });
    expect(cfg.httpBaseUrl).toBe(cfg.serverUrl);
  });
});

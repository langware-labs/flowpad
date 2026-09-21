import {
  PROTOCOL_API_CHAT_OPENAI,
  PROTOCOL_API_MCP,
  PROTOCOL_API_REST,
  PROTOCOL_WEB_APP,
  PROTOCOL_WORKSPACE,
  ServiceEndpoint,
  surfaceOf,
} from '@sdk';
import { describe, expect, it } from 'vitest';

const ID = '2c3d7e0a-5a1b-4f7e-9d2c-8b6a1e4f0c11';

function endpoint(over: Record<string, unknown> = {}) {
  return new ServiceEndpoint({
    id: ID,
    name: 'chat',
    parent_type_id: 'deployment-7a1f9b3c-2d4e-4a6b-8c0d-1e2f3a4b5c6d',
    protocol: { spec_kind: PROTOCOL_API_CHAT_OPENAI, base_path: '/v1' },
    backend: { type: 'proxy', port: 8123 },
    ...over,
  } as never);
}

describe('ServiceEndpoint SDK model', () => {
  it('keeps the protocol in its tagged wire form, kind normalized', () => {
    const e = endpoint({ protocol: { spec_kind: ' API.Chat.OpenAI ', base_path: '/v1' } });
    expect(e.protocol).toEqual({ spec_kind: 'api.chat.openai', base_path: '/v1' });
    expect(e.kind).toBe('api.chat.openai');
  });

  it('normalizes both backends and refuses a bad one', () => {
    expect(endpoint().backend).toEqual({ type: 'proxy', port: 8123, start_cmd: null, health: '/' });
    expect(endpoint({ backend: { type: 'static', root: '/srv/dist' } }).backend).toEqual({
      type: 'static',
      root: '/srv/dist',
    });
    expect(() => endpoint({ backend: { type: 'proxy', port: 0 } })).toThrow(/out of range/);
    expect(() => endpoint({ backend: { type: 'bucket', root: 'gs://x' } })).toThrow(/unknown backend/);
  });

  it('requires a protocol kind and a name', () => {
    expect(() => endpoint({ protocol: { base_path: '/v1' } })).toThrow(/spec_kind/);
    expect(() => endpoint({ name: '' })).toThrow(/name/);
  });

  it('does not claim direct access unless declared', () => {
    expect(endpoint().supports_direct_access).toBe(false);
    expect(endpoint({ supports_direct_access: true }).supports_direct_access).toBe(true);
  });

  it.each([
    [PROTOCOL_WEB_APP, 'web'],
    [PROTOCOL_WORKSPACE, 'web'],
    [PROTOCOL_API_REST, 'api'],
    [PROTOCOL_API_CHAT_OPENAI, 'api'],
    [PROTOCOL_API_MCP, 'api'],
    ['--acme--.web.shop', 'web'],
    ['--acme--.api.orders', 'api'],
    ['grpc.web.echo', 'api'],
  ])('%s is served to %s callers — same rule as the backend', (kind, surface) => {
    expect(surfaceOf(kind)).toBe(surface);
  });

  it('proxies at …/service_endpoint/<id>/service/<path>', () => {
    const url = endpoint().serviceUrl('/v1/chat/completions');
    expect(url.endsWith(`/service_endpoint/${ID}/service/v1/chat/completions`)).toBe(true);
    expect(endpoint().serviceUrl().endsWith(`/service_endpoint/${ID}/service/`)).toBe(true);
  });
});

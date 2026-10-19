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

  describe('an audience proxy (routed)', () => {
    const routed = () =>
      endpoint({
        name: 'app',
        subkind: 'app',
        protocol: { spec_kind: PROTOCOL_WEB_APP },
        backend: {
          type: 'routed',
          routes: {
            '': { backend: { type: 'static', root: '/srv/shop' }, webapp_id: 'w-root' },
            docs: { backend: { type: 'proxy', port: 5173 }, artifact_id: 'a-docs' },
          },
        },
      });

    it('normalizes every route and refuses one that is not files or a process', () => {
      expect(routed().backend).toEqual({
        type: 'routed',
        routes: {
          '': { backend: { type: 'static', root: '/srv/shop' }, webapp_id: 'w-root', artifact_id: null },
          docs: {
            backend: { type: 'proxy', port: 5173, start_cmd: null, health: '/' },
            webapp_id: null,
            artifact_id: 'a-docs',
          },
        },
      });
      const channel = { type: 'routed', routes: { x: { backend: { type: 'channel', data_source_id: 's' } } } };
      expect(() => endpoint({ backend: channel })).toThrow(/must serve files or a process/);
    });

    it('serves one app per mount, each addressed by the proxy AND its mount', () => {
      const [root, docs] = routed().served();
      expect([root.mount, docs.mount]).toEqual(['', 'docs']);
      expect([root.id, docs.id]).toEqual([ID, ID]);
      expect(root.webapp_id).toBe('w-root');
      expect(docs.artifact_id).toBe('a-docs');
      expect(docs.backend).toMatchObject({ type: 'proxy', port: 5173 });
      expect(root.serviceUrl()).toMatch(new RegExp(`/service_endpoint/${ID}/service/$`));
      expect(docs.serviceUrl('a.js')).toMatch(new RegExp(`/service_endpoint/${ID}/service/docs/a.js$`));
    });

    it('finds the app at a mount, and nothing where it routes none', () => {
      expect(routed().servedAt('docs')?.mount).toBe('docs');
      expect(routed().servedAt(null)?.mount).toBe('');
      expect(routed().servedAt('nobody')).toBeNull();
    });

    it('an endpoint of its own serves itself, with no mount', () => {
      const [own] = endpoint().served();
      expect(own.mount).toBeNull();
      expect(own.backend).toMatchObject({ type: 'proxy', port: 8123 });
      expect(own.serviceUrl('v1/models')).toMatch(new RegExp(`/service_endpoint/${ID}/service/v1/models$`));
    });
  });

  it('names what an endpoint is for: the machine is `system`, never `admin`', () => {
    expect(endpoint({ protocol: { spec_kind: PROTOCOL_WORKSPACE } }).subkind).toBe('system');
    expect(endpoint({ protocol: { spec_kind: PROTOCOL_WEB_APP } }).subkind).toBe('app');
    expect(endpoint({ protocol: { spec_kind: PROTOCOL_API_MCP } }).subkind).toBe('service');
    expect(endpoint({ subkind: 'admin' }).subkind).toBe('admin');
  });
});

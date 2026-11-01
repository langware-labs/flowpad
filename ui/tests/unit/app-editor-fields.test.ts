/**
 * The app editor's `webapp.json` helpers: the implicit mount, the two spellings of a port, switching how a
 * process runs, and the address a mount opens at — the twin of `WebappManifestSpec` / `effective_mounts`.
 */
import { describe, expect, it } from 'vitest';

import {
  MOUNT_PATTERN,
  addressOf,
  declaredPort,
  effectiveMounts,
  switchServing,
  withPort,
  type ProxyServing,
} from '@src/components/assets/editor/app-profile/app-fields';

const proxy: ProxyServing = { type: 'proxy', start_cmd: 'python3 serve.py {port}', health: '/api/health' };

describe('app editor fields', () => {
  it('shows the one implicit static mount, and none for an app that only declares services', () => {
    expect(effectiveMounts(undefined, undefined)).toEqual([{ audience: 'app', serving: { type: 'static', root: '' } }]);
    expect(effectiveMounts([], [{ name: 'api', protocol: { spec_kind: 'api.rest' }, serving: proxy }])).toEqual([]);
    const declared = [{ audience: 'admin' as const, serving: proxy }];
    expect(effectiveMounts(declared, undefined)).toBe(declared);
  });

  it('reads both spellings of a port and always writes ports.local', () => {
    expect(declaredPort(proxy)).toBeNull();
    expect(declaredPort({ ...proxy, port: 8090 })).toEqual({ port: 8090, required: true });
    const written = withPort({ ...proxy, port: 8090 }, { port: 8091, required: false });
    expect(written).toEqual({ ...proxy, ports: { local: { port: 8091, required: false } } });
    expect(declaredPort(written)).toEqual({ port: 8091, required: false });
    expect(withPort(written, null)).toEqual(proxy);
  });

  it('switching how it runs keeps only what the new way has', () => {
    expect(switchServing(proxy, 'static')).toEqual({ type: 'static', root: '' });
    expect(switchServing({ type: 'static', root: 'dist' }, 'proxy')).toEqual({ type: 'proxy', start_cmd: '' });
    expect(switchServing(proxy, 'proxy')).toBe(proxy);
  });

  it('opens at its path, its own name, or the audience root', () => {
    expect(addressOf({ path: 'docs' }, 'spora-admin')).toBe('/docs/');
    expect(addressOf({}, 'spora-admin')).toBe('/spora-admin/');
    expect(addressOf({ path: '' }, 'spora-admin')).toBe('/');
  });

  it('accepts the addresses the backend accepts', () => {
    for (const ok of ['', 'docs', 'spora-admin', 'v1.2_x~y']) expect(MOUNT_PATTERN.test(ok)).toBe(true);
    for (const bad of ['Bad Path!', '-lead', 'a/b', '.hidden']) expect(MOUNT_PATTERN.test(bad)).toBe(false);
  });
});

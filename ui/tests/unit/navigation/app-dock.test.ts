/**
 * The app dock's pointer grammar:
 * `/dock/app/<artifact|micro_app>-<uuid>[?runtime=…][&host=…]`.
 *
 * An app built from source is addressed by its ARTIFACT, because the runtime is
 * DERIVED from its Deployment / MicroApp companions at render time. These pin that
 * the URL carries identity plus a preference, and never a port — a port in the
 * pointer is how a dev server that has since died becomes the app's identity.
 *
 * A webapp ASSET on disk has no Artifact and no dev server, so it is addressed by
 * its own delivery row. That is also what gives it a breadcrumb: a `micro_app` has
 * a parent asset, an artifact names a plane.
 */
import { describe, expect, it } from 'vitest';
import { appDockAddress } from '@src/navigation/app-dock';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const ARTIFACT = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const HOST = 'agentic_process-abc1e873-1ae2-4c55-9242-6b4ddea51420';
const MICRO_APP = 'c6f0e1a2-1111-4222-8333-444455556666';
const appDock = (options?: Record<string, string>) =>
  new DockPointer(ViewType.APP, `artifact-${ARTIFACT}`, options);
const assetDock = (options?: Record<string, string>) =>
  new DockPointer(ViewType.APP, `micro_app-${MICRO_APP}`, options);

describe('appDockAddress', () => {
  it('reads the artifact as the address', () => {
    expect(appDockAddress(appDock())).toEqual({
      artifactId: ARTIFACT,
      microAppId: null,
      host: null,
      runtime: null,
      options: {},
    });
  });

  it('carries the runtime as a preference', () => {
    expect(appDockAddress(appDock({ runtime: 'served' }))?.runtime).toBe('served');
    expect(appDockAddress(appDock({ runtime: 'dev' }))?.runtime).toBe('dev');
  });

  it('ignores a runtime the viewer cannot select', () => {
    // `unbuilt` is a derived STATE, never a choice — pinning it would ask the viewer
    // for something it has no way to render.
    expect(appDockAddress(appDock({ runtime: 'unbuilt' }))?.runtime).toBeNull();
    expect(appDockAddress(appDock({ runtime: 'nonsense' }))?.runtime).toBeNull();
  });

  it('hands everything else to the app as its query string', () => {
    // An app is told what to act on through its URL and nothing else. `runtime`
    // is the exception: it addresses the VIEWER, so it must not leak into the app.
    const addr = appDockAddress(assetDock({ source: 'abc', runtime: 'served' }));
    expect(addr?.options).toEqual({ source: 'abc' });
    expect(addr?.runtime).toBe('served');
  });

  it('carries the host, which only the dev runtime needs', () => {
    // A dev server's URL resolves through the owning process's compute node, so an
    // app shown outside a workspace can still serve built output but has no dev port.
    expect(appDockAddress(appDock().withHost(HOST))?.host).toBe(HOST);
  });

  it('keeps the runtime out of tab identity', () => {
    // So flipping dev⇄served re-points the SAME tab instead of forking one per runtime.
    expect(appDock({ runtime: 'dev' }).tabHash).toBe(appDock({ runtime: 'served' }).tabHash);
    expect(appDock().tabHash).toBe(`app|artifact-${ARTIFACT}`);
  });

  it('reads a webapp asset by its own delivery row', () => {
    // No artifact at all: the app IS the asset on disk, so the row is the address.
    expect(appDockAddress(assetDock())).toEqual({
      artifactId: null,
      microAppId: MICRO_APP,
      host: null,
      runtime: null,
      options: {},
    });
    expect(assetDock().tabHash).toBe(`app|micro_app-${MICRO_APP}`);
  });

  it('answers null rather than guessing at an app', () => {
    expect(appDockAddress(null)).toBeNull();
    expect(appDockAddress(new DockPointer(ViewType.APP))).toBeNull();
    // A pointer naming some OTHER entity is not an app address. Reading its uuid
    // as an artifact would query for a row that cannot exist and render blank.
    expect(appDockAddress(new DockPointer(ViewType.APP, `dataset-${ARTIFACT}`))).toBeNull();
  });
});

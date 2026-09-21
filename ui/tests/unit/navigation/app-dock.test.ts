/**
 * The app dock's pointer grammar:
 * `/dock/app/<artifact|micro_app|service_endpoint>-<uuid>[?runtime=…]`.
 *
 * Every form resolves to the ServiceEndpoints that serve the app. An app built
 * from source is addressed by its ARTIFACT, because which endpoint shows is
 * DERIVED at render time; a webapp ASSET by its definition; a bare dev server by
 * its endpoint. These pin that the URL carries identity plus a preference, and
 * never a port — a port in the pointer is how a dev server that has since died
 * becomes the app's identity.
 */
import { describe, expect, it } from 'vitest';
import { appDockAddress } from '@src/navigation/app-dock';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const ARTIFACT = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const MICRO_APP = 'c6f0e1a2-1111-4222-8333-444455556666';
const appDock = (options?: Record<string, string>) =>
  new DockPointer(ViewType.APP, `artifact-${ARTIFACT}`, options);
const assetDock = (options?: Record<string, string>) =>
  new DockPointer(ViewType.APP, `micro_app-${MICRO_APP}`, options);
const ENDPOINT = '9a1c2b3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const endpointDock = (options?: Record<string, string>) =>
  new DockPointer(ViewType.APP, `service_endpoint-${ENDPOINT}`, options);

describe('appDockAddress', () => {
  it('reads the artifact as the address', () => {
    expect(appDockAddress(appDock())).toEqual({
      artifactId: ARTIFACT,
      microAppId: null,
      endpointId: null,
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

  it('reads a bare dev server by its endpoint', () => {
    // `flow show webapp --port N` registered an endpoint; the endpoint IS the address.
    expect(appDockAddress(endpointDock({ runtime: 'dev' }))).toEqual({
      artifactId: null,
      microAppId: null,
      endpointId: ENDPOINT,
      runtime: 'dev',
      options: {},
    });
    expect(endpointDock({ runtime: 'dev' }).tabHash).toBe(`app|service_endpoint-${ENDPOINT}`);
  });

  it('keeps the runtime out of tab identity', () => {
    // So flipping dev⇄served re-points the SAME tab instead of forking one per runtime.
    expect(appDock({ runtime: 'dev' }).tabHash).toBe(appDock({ runtime: 'served' }).tabHash);
    expect(appDock().tabHash).toBe(`app|artifact-${ARTIFACT}`);
  });

  it('reads a webapp asset by its definition', () => {
    // No artifact at all: the app IS the asset on disk, so its definition is the address.
    expect(appDockAddress(assetDock())).toEqual({
      artifactId: null,
      microAppId: MICRO_APP,
      endpointId: null,
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

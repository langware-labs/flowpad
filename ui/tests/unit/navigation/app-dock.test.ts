/**
 * The app dock's pointer grammar: `/dock/app/artifact-<uuid>[?runtime=…][&host=…]`.
 *
 * The artifact is the address because the runtime is DERIVED from its Deployment /
 * MicroApp companions at render time. These pin that the URL carries identity plus a
 * preference, and never a port — a port in the pointer is how a dev server that has
 * since died becomes the app's identity.
 */
import { describe, expect, it } from 'vitest';
import { appDockAddress } from '@src/navigation/app-dock';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const ARTIFACT = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const HOST = 'agentic_process-abc1e873-1ae2-4c55-9242-6b4ddea51420';
const appDock = (options?: Record<string, string>) =>
  new DockPointer(ViewType.APP, `artifact-${ARTIFACT}`, options);

describe('appDockAddress', () => {
  it('reads the artifact as the address', () => {
    expect(appDockAddress(appDock())).toEqual({ artifactId: ARTIFACT, host: null, runtime: null });
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

  it('answers null rather than guessing at an artifact', () => {
    expect(appDockAddress(null)).toBeNull();
    expect(appDockAddress(new DockPointer(ViewType.APP))).toBeNull();
  });
});

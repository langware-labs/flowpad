/**
 * Vibe project URL → vibe workspace (no mocks, real router loaders).
 *
 * Reproduces the reported bug: opening a project directly by URL in vibe mode —
 * `/dock/project/<id>?viewMode=vibe` — should land in the VIBE WORKSPACE, but
 * instead renders the standard "Project assets" project home.
 *
 * Proven root cause (this session): vibe mode IS applied for such a URL
 * (`data-view="vibe"`), yet `flow-page` falls through to `<ContentPanel/>` (the
 * standard project home) because a `project` viewType dock is not a workspace
 * surface (`useVibeWorkspaceSession` only recognizes SHELL/process docks) and
 * NOTHING redirects a vibe-mode project dock to a workspace surface. Only the
 * in-app project picker (`open-project-component`) does that redirect; direct
 * URL navigation skips it. Live proof: the same project via the picker landed on
 * `/dock/home?vibeNoProcess=true&viewMode=vibe` (the VibeNoProcessWorkspace),
 * while the raw project URL rendered the project home.
 *
 * Narrowest faithful layer: the headless in-process E2E tier boots the REAL app
 * and runs the REAL react-router loaders against a live backend — exactly where
 * the surface/redirect decision lives — with no mocks and no invented fix seam.
 *
 * A freshly-created project has no vibe process, so the correct vibe surface is
 * deterministically `VibeNoProcessWorkspace` (data-testid `vibe-no-process-workspace`),
 * regardless of whether the fix lands as a loader redirect or a flow-page surface
 * pick. On the buggy code that testid never mounts (the project home renders).
 *
 * Prereq: an explicitly selected disposable instance_ctl backend.
 * Run: `cd ui && FLOW_INSTANCE=<disposable-name> npm run test:vitest:headless`
 */
import { describe, expect, it } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { setupLiveBackend, bootApp } from './_harness';
import { trackForCleanup, testEntityName } from '../_cleanup';
import { createSdkRealm } from '../_sdk_realm';

const backend = setupLiveBackend('[vibe project url]');

describe('vibe project URL lands in the vibe workspace (no mocks)', () => {
  it('/dock/project/<id>?viewMode=vibe renders the vibe workspace, not the project home', async () => {
    const live = backend.current;
    if (!live) throw new Error('headless backend preflight did not resolve FLOW_INSTANCE');

    // Point the realm at the live backend and re-evaluate the SDK graph so the
    // project we create and the app we boot share ONE realm bound to this backend.
    const { sdk } = await createSdkRealm(live.apiUrl);
    await sdk.initSdk();

    // A fresh project has NO vibe process → the correct vibe surface is
    // deterministically VibeNoProcessWorkspace. Scope to the current user so
    // the loader's `dataManager.getByTypeId` resolves it.
    const someone = sdk.dataContext.someone;
    const project = trackForCleanup(
      await new sdk.Project({ name: testEntityName('vibe-url') }).save(someone ? [someone] : []),
    );
    const projectId = project.id;
    expect(projectId).toBeTruthy();

    // "Opening in vibe mode": pin the effective mode to Vibe before boot (avoids
    // any per-project last_mode race) — the reported scenario is the ?viewMode
    // param, which we also carry on the URL below.
    const { setViewMode, ViewMode } = await import('@src/contexts/view-mode-context');
    setViewMode(ViewMode.Vibe);

    const { container, router } = await bootApp();

    const { DockPointer } = await import('@src/navigation/DockPointer');
    const url = DockPointer.forProject(projectId).withViewMode(ViewMode.Vibe).toUrl();
    expect(url).toContain(`/dock/project/${projectId}`);
    expect(url).toContain('viewMode=vibe');

    await act(async () => {
      await router.navigate(url);
    });

    // Wait until a DECISIVE surface mounts — either the vibe workspace
    // (`vibe-no-process-workspace`) or the standard project home
    // (`project-home-*`). Racing them resolves as soon as one paints, so the
    // assertion (not the harness timeout) is the failure signal on buggy code.
    const surface = await waitFor(
      () => {
        const workspace = container.querySelector('[data-testid="vibe-no-process-workspace"]');
        const projectHome = container.querySelector(
          '[data-testid="project-home-members"], [data-testid="project-home-start-session"]',
        );
        if (workspace) return 'workspace';
        if (projectHome) return 'project-home';
        throw new Error('no decisive surface yet');
      },
      { timeout: 15000 }, // do not increase timeout without approval
    );

    // Precondition: vibe mode really is active for this URL (isolates the SURFACE
    // bug from a mode-selection bug — the live repro showed data-view=vibe here).
    expect(document.documentElement.getAttribute('data-view')).toBe('vibe');

    if (surface !== 'workspace') {
      console.error(
        '[vibe project url][DEBUG] rendered surface:',
        surface,
        '| pathname:',
        router.state.location.pathname + router.state.location.search,
        '| data-view:',
        document.documentElement.getAttribute('data-view'),
      );
    }
    // The bug: a vibe-mode project URL renders the standard project home instead
    // of a workspace surface. The fix must resolve it to the vibe workspace.
    expect(surface).toBe('workspace');
  });
});

/**
 * Every kind of place, with REAL entities, in every shipped view mode —
 * docs/navigation/dock-loading.md in a browser.
 *
 * The dock sweep (../dock-sweep) proves every URL family in the grammar fixture
 * is carried; its ids are made up, so pointer rows mostly prove "absent → stay
 * put". This spec seeds a real world (a project with a report, a PTY session on
 * the mock worker, a plain shell) and walks every place that world has, steered
 * in-app from ONE loaded page — the way a user moves, and the only way warm
 * switches happen at all.
 *
 * Per place and mode:
 *   - the URL lands on the place, no dock-load-error, no uncaught exception;
 *   - "This session has nothing to display" never appears;
 *   - the loader ran with at most one redirect (I2), read from the app's own
 *     `tab_switch` trail.
 */
import { expect, test } from '@playwright/test';
import { withViewMode, type QaViewMode } from '../_shared/view-mode';
import {
  awaitSteerable,
  createWorld,
  destroyWorld,
  installObservers,
  navigateTo,
  nothingToDisplaySightings,
  toplogOn,
  type World,
} from './_world';

const MODES: QaViewMode[] = ['standard', 'advanced', 'vibe'];
/** Headless Chromium has no GPU: WebGL graph views throw on getParameter regardless of the app. */
const HEADLESS_WEBGL = /getParameter|WebGL|webgl/;

let world: World;

test.beforeAll(async () => {
  world = await createWorld('every-place');
  await toplogOn(['tab_switch']);
});

test.afterAll(async () => {
  if (world) await destroyWorld(world);
});

function places(w: World, mode: QaViewMode): { name: string; address: string; path: string }[] {
  return [
    {
      name: 'the mock session terminal',
      address: `shell/agentic_process-${w.processId}`,
      // Shown in Vibe, a session lands on its Vibe HOST address (`/dock/vibe/…`).
      path: `/${mode === 'vibe' ? 'vibe' : 'shell'}/agentic_process-${w.processId}`,
    },
    { name: 'a plain shell', address: `shell/shell-${w.shellId}`, path: `/shell/shell-${w.shellId}` },
    {
      name: 'the report inside the project',
      address: `project/${w.projectId}/editor/markdown/vfs/compute_node-%40local${w.reportPath}`,
      path: '/editor/markdown/',
    },
    { name: 'the project page', address: `project/${w.projectId}`, path: `/project/${w.projectId}` },
    { name: 'the assets browser', address: 'assets/list/skill', path: '/assets/list/skill' },
    { name: 'the automations screen', address: 'automations', path: '/automations' },
    { name: 'the explorer', address: 'explorer', path: '/explorer' },
    { name: 'the desktop', address: 'desktop', path: '/desktop' },
  ];
}

for (const mode of MODES) {
  test(`every place renders — ${mode}`, async ({ page }) => {
    const { toplog } = await installObservers(page);
    const exceptions: string[] = [];
    page.on('pageerror', (e) => exceptions.push(e.message));

    await page.goto(withViewMode('/dock/desktop', mode));
    await expect(page.locator('html')).toHaveAttribute('data-view', mode);
    await awaitSteerable(page);

    for (const place of places(world, mode)) {
      await test.step(place.name, async () => {
        const before = toplog.length;
        await navigateTo(page, `${place.address}${place.address.includes('?') ? '&' : '?'}viewMode=${mode}`, place.path);
        await expect(page.getByTestId('dock-load-error')).toHaveCount(0);
        await expect(page.locator('html')).toHaveAttribute('data-view', mode);
        const redirects = toplog.slice(before).filter((l) => l.includes('loader_redirect'));
        expect(redirects.length, `more than one redirect for ${place.name}:\n${redirects.join('\n')}`).toBeLessThanOrEqual(1);
        expect(await nothingToDisplaySightings(page), `"nothing to display" at ${place.name}`).toEqual([]);
      });
    }

    // Non-vacuous: the redirect budget above read a real trail.
    expect(toplog.filter((l) => l.includes(' loader ')).length, 'no tab_switch loader lines reached the page').toBeGreaterThan(0);
    expect(exceptions.filter((e) => !HEADLESS_WEBGL.test(e)), 'uncaught exceptions').toEqual([]);
  });
}

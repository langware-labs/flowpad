/**
 * Terminal round trips — docs/navigation/dock-loading.md, I6 in a real browser.
 *
 * A live agentic-process terminal (the MOCK worker in a real PTY) → every other
 * kind of place → back. Reported 2026-09-27: the report a terminal link opened
 * (`/dock/project/<P>/editor/markdown/…`) swapped the layout and the terminal
 * came back empty, then re-opened and replayed its whole recording.
 *
 * Per round trip, on the way back:
 *   - the SAME xterm DOM node is showing (a rebuild is a new node);
 *   - the process was not re-opened and its recording not re-downloaded;
 *   - the worker's output is on screen;
 *   - "This session has nothing to display" never appeared.
 *
 * Run (disposable instance with the mock worker — see ./_world.ts):
 *   VITE_PORT=5007 FLOW_INSTANCE=dlm-7 npx playwright test \
 *     --config tests/manual_regression/navigation/playwright.config.ts terminal_round_trips
 */
import { expect, test, type Page } from '@playwright/test';
import {
  awaitSteerable,
  createWorld,
  destroyWorld,
  installObservers,
  MOCK_MARKER,
  navigateTo,
  nothingToDisplaySightings,
  toplogOn,
  type World,
} from './_world';

let world: World;

test.beforeAll(async () => {
  world = await createWorld('round-trip');
  await toplogOn(['tab_switch', 'pty']);
});

test.afterAll(async () => {
  if (world) await destroyWorld(world);
});

const panel = (page: Page, processId: string) => page.locator(`[data-session-id="agentic_process-${processId}"]`);

/** Remember the terminal node on screen now, to compare after a round trip. */
async function pinTerminalNode(page: Page, processId: string): Promise<void> {
  await page.evaluate((id) => {
    const node = document.querySelector(`[data-session-id="agentic_process-${id}"] .xterm`);
    (window as unknown as { __pinnedXterm: Element | null }).__pinnedXterm = node;
  }, processId);
}

async function sameTerminalShowing(page: Page, processId: string): Promise<{ same: boolean; visible: boolean }> {
  return page.evaluate((id) => {
    const pinned = (window as unknown as { __pinnedXterm: Element | null }).__pinnedXterm;
    const now = document.querySelector(`[data-session-id="agentic_process-${id}"] .xterm`);
    return {
      same: !!pinned && pinned === now && document.contains(pinned),
      visible: !!now && (now as HTMLElement).offsetParent !== null,
    };
  }, processId);
}

test('a terminal survives every trip away and back', async ({ page }) => {
  const { toplog } = await installObservers(page);
  const reruns: string[] = [];
  page.on('request', (r) => {
    const url = r.url();
    if (url.includes(`/agentic_process/${world.processId}/open`) || url.includes(`/shell/${world.processShellId}/pty-stream`))
      reruns.push(url);
  });

  await page.goto('/dock/desktop?viewMode=advanced');
  await awaitSteerable(page);

  const processAddress = `shell/agentic_process-${world.processId}`;
  const processPath = `/shell/agentic_process-${world.processId}`;
  await navigateTo(page, processAddress, processPath);
  await expect(panel(page, world.processId).locator('.xterm')).toBeVisible();
  await expect(panel(page, world.processId)).toContainText(MOCK_MARKER, { timeout: 15_000 });
  await pinTerminalNode(page, world.processId);
  let firstVisitRequests = reruns.length;

  // `modeSwitch`: the SAME session in Vibe is a headless chat, so the visit
  // switches its transport (PTY → headless) and the way back relaunches the PTY —
  // a mode switch by design, not a tab switch. It must still come back working,
  // and never through "nothing to display"; it is not held to "same node".
  const places: { name: string; address: string; path: string; modeSwitch?: boolean }[] = [
    {
      name: 'the report a terminal link opens (the 2026-09-27 repro)',
      address: `project/${world.projectId}/editor/markdown/vfs/compute_node-%40local${world.reportPath}`,
      path: '/editor/markdown/',
    },
    { name: 'the project page', address: `project/${world.projectId}`, path: `/project/${world.projectId}` },
    { name: 'the assets browser', address: 'assets/list/skill', path: '/assets/list/skill' },
    { name: 'the automations screen', address: 'automations', path: '/automations' },
    { name: 'a plain shell', address: `shell/shell-${world.shellId}`, path: `/shell/shell-${world.shellId}` },
    { name: 'the same session in Vibe', address: `${processAddress}?viewMode=vibe`, path: processPath, modeSwitch: true },
    { name: 'the desktop', address: 'desktop', path: '/desktop' },
  ];

  for (const place of places) {
    await test.step(`→ ${place.name} → back`, async () => {
      await navigateTo(page, place.address, place.path);
      await navigateTo(page, `${processAddress}?viewMode=advanced`, processPath);

      expect(await nothingToDisplaySightings(page), `"nothing to display" during ${place.name}`).toEqual([]);
      if (place.modeSwitch) {
        await expect(panel(page, world.processId).locator('.xterm').first()).toBeVisible();
        await expect(panel(page, world.processId)).toContainText(MOCK_MARKER, { timeout: 15_000 });
        // The relaunched PTY re-attaches (and re-streams) on its own schedule: let
        // it settle, then later trips compare against the terminal it left behind.
        await expect
          .poll(
            async () => {
              const n = reruns.length;
              await page.waitForTimeout(750);
              return reruns.length === n;
            },
            { timeout: 15_000 },
          )
          .toBe(true);
        await pinTerminalNode(page, world.processId);
        firstVisitRequests = reruns.length;
        return;
      }
      await expect.poll(() => sameTerminalShowing(page, world.processId)).toEqual({ same: true, visible: true });
      await expect(panel(page, world.processId)).toContainText(MOCK_MARKER);
      expect(reruns.slice(firstVisitRequests), `re-opened or re-streamed after ${place.name}`).toEqual([]);
    });
  }

  await test.step('the same trip by clicking tab chips', async () => {
    await page.locator('[data-testid^="tab-"]', { hasText: 'report.md' }).first().click();
    await expect.poll(() => new URL(page.url()).pathname).toContain('/editor/markdown/');
    await page.getByTestId(`tab-shell|agentic_process-${world.processId}`).first().click();
    await expect.poll(() => new URL(page.url()).pathname).toContain(processPath);
    await expect.poll(() => sameTerminalShowing(page, world.processId)).toEqual({ same: true, visible: true });
    expect(reruns.slice(firstVisitRequests)).toEqual([]);
    expect(await nothingToDisplaySightings(page)).toEqual([]);
  });

  // The app's own account of it, when tab_switch tracing is on: no cold remount.
  const remounts = toplog.filter((l) => l.includes('xterm_mount') && l.includes(world.processId));
  expect(remounts.length, `xterm remounts:\n${remounts.join('\n')}`).toBeLessThanOrEqual(1);
});

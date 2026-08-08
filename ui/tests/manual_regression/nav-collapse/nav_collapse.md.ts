import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { selectViewMode } from '../_shared/view-mode';

/**
 * Browser proof for the navigation collapse: the app root `/` is an ordinary
 * location, and nothing composes a URL onto a location it has already left.
 *
 * The unit tier proves the pointer algebra. What it cannot prove is the thing
 * the collapse was FOR: that a write issued while React Router is mid-navigation
 * lands on the destination. That needs the real router, real loaders, and real
 * async — so it needs a browser.
 *
 * Run against a launcher instance, never the user's own dev server:
 *   VITE_PORT=5002 npx playwright test \
 *     --config tests/manual_regression/nav-collapse/playwright.config.ts
 *
 * ONE page for the whole file, deliberately. Playwright's per-test context gets
 * an empty HTTP cache, so every test re-pulls this app's entire Vite dev module
 * graph cold — which made navigations miss the budget, and made the failure
 * wander to whichever test happened to run first. A user navigates in one warm
 * session; so does this. Tests still start from a `goto`, so each states its own
 * starting location rather than inheriting the previous test's.
 */

let page: Page;
/** Round-trip + pointer failures only. Unrelated app noise (failed asset
 *  fetches, WS reconnects) must not mask or fake a result. The app's own DEV
 *  assertion — `fromUrl(url).toUrl() === url` on every navigation — lands here. */
let errors: string[] = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() !== 'error') return;
    if (/round.?trip|DockPointer|toUrl|fromUrl|navigat/i.test(m.text())) errors.push(m.text());
  });
});
test.beforeEach(() => {
  errors = [];
});
test.afterAll(async () => {
  await page.close();
});

const here = () => page.evaluate(() => window.location.pathname + window.location.search);

test.describe('navigation collapse — root is a location', () => {
  test('`/dock/home` canonicalizes to `/`, and both render the same home', async () => {

    await page.goto('/');
    await expect(page.locator('[data-tag]').first()).toBeVisible();
    const rootPath = await here();
    expect(rootPath).toBe('/');

    await page.goto('/dock/home');
    // The collapse: the dock spelling of the root resolves to the root's URL.
    await expect.poll(() => here()).toBe('/');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('root carries its options through a round trip', async () => {
    // A root URL with options is the shape that had no type before this work.
    await page.goto('/?highlight=RailChats');
    await expect.poll(() => here()).toContain('highlight=RailChats');
    await expect.poll(() => here()).toMatch(/^\/\?/);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('`/dev/…` still reaches its `/dock/…` twin', async () => {
    await page.goto('/dev/explorer');
    await expect.poll(() => here()).toContain('/dock/explorer');
  });

  test('back from a dock returns to the root as a real history entry', async () => {
    await page.goto('/');
    await page.goto('/dock/explorer');
    await expect.poll(() => here()).toContain('/dock/explorer');
    await page.goBack();
    await expect.poll(() => here()).toBe('/');
  });
});

test.describe('the race the collapse was for', () => {
  /**
   * The original defect, reduced to its mechanism: ask for a navigation, then
   * immediately compose another param onto the location. Before the collapse the
   * second write read `window.location` as a string — still the PRE-navigation
   * URL — and committed it, reverting the navigation in flight.
   *
   * Asserting on the settled URL is the whole point: the destination must win,
   * and the composed param must ride along rather than replace it.
   */
  test('a param written during an in-flight navigation lands on the destination', async () => {
    await page.goto('/');
    await expect(page.locator('[data-tag]').first()).toBeVisible();

    await page.evaluate(() => {
      history.pushState(null, '', '/dock/explorer');
      window.dispatchEvent(new PopStateEvent('popstate'));
      // Same tick — the loader has not run, the URL has not settled.
      history.replaceState(null, '', window.location.pathname + '?highlight=RailChats');
    });

    await expect.poll(() => here()).toContain('/dock/explorer');
    await expect.poll(() => here()).toContain('highlight=RailChats');
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('vibe exit — the end-to-end proof', () => {
  /**
   * The journey that exposed everything: enter Vibe, open a build, then leave.
   * Before the fix the exit step narrated a departure that never happened — with
   * a journey running, the mode stayed `vibe` and the workspace stayed mounted.
   *
   * `VibeDisplay` is the WORKSPACE pane, not the vibe home: switching mode at the
   * root only swaps the home. So the build has to be opened, exactly as the
   * journey's `open_build` step does, or the exit proves nothing.
   */
  /**
   * Setup enters Vibe by URL, not by clicking the footer. The footer toggle is
   * the control UNDER TEST in the exit proof — driving setup with it makes a
   * slow preference write look like an exit failure, and that is what it did.
   * `?viewMode=` is a real address (pinned below), so setup can just say where
   * it wants to be and wait for the app to be there.
   */
  async function enterVibeWorkspace(start = '/'): Promise<void> {
    const url = new URL(start, 'http://x');
    url.searchParams.set('viewMode', 'vibe');
    await page.goto(`${url.pathname}${url.search}`);
    await expect(page.locator('html')).toHaveAttribute('data-view', 'vibe');
    await page.locator('[data-tag="RailChats"]').click();
    await expect(page.locator('[data-tag="VibeDisplay"]')).toBeVisible();
  }

  test('the mode switch actually leaves Vibe, with a journey running', async () => {
    await enterVibeWorkspace('/?journeyId=@vibe-exit-mode-switch');

    await selectViewMode(page, 'standard');
    // The exact assertion that failed before: the workspace must really go.
    await expect(page.locator('[data-tag="VibeDisplay"]')).toHaveCount(0);
    await expect.poll(() => here()).toContain('viewMode=standard');
    // ...and the journey must survive the write that carried the mode change.
    // The old `showJourney` branch dropped every other param; this is that guard.
    await expect.poll(() => here()).toContain('journeyId=');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('re-entering Vibe remounts the workspace', async () => {
    await enterVibeWorkspace();
    await selectViewMode(page, 'standard');
    await expect(page.locator('[data-tag="VibeDisplay"]')).toHaveCount(0);
    await selectViewMode(page, 'vibe');
    await expect(page.locator('[data-tag="VibeDisplay"]')).toBeVisible();
  });
});

test.describe('the root carries view mode', () => {
  /**
   * The one place the collapse changes MEANING rather than spelling, flagged in
   * the plan's risk register: before, `/` could not carry options, so view mode
   * at the root came only from the stored preference. Now `/?viewMode=` is a
   * real address and is authoritative — which is what makes a mode switch at
   * home shareable and reloadable at all.
   */
  test('`/?viewMode=` survives a reload and beats the stored preference', async () => {
    await page.goto('/');
    await selectViewMode(page, 'standard');

    await page.goto('/?viewMode=vibe');
    await expect(page.locator('html')).toHaveAttribute('data-view', 'vibe');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-view', 'vibe');
    await expect.poll(() => here()).toContain('viewMode=vibe');
  });
});

test.describe('the root adopts scope', () => {
  /**
   * The collapse's one loader change: `loadHomePage` gained `adoptScopeProject`,
   * so `/?scope-…` means what `/dock/home?scope-…` already meant. Before, the
   * root did no scope adoption at all — a project switch that landed on home
   * left the previous project in context (the stuck-footer bug).
   *
   * Two DIFFERENT projects, back to back, because one proves nothing: the root
   * already showed the remembered project. Only a switch distinguishes "adopted
   * the URL's scope" from "rendered whatever was last active".
   */
  test('`/?scope-…` switches the project in context', async () => {
    await page.goto('/');
    await expect(page.getByTestId('footer')).toBeVisible();

    // Discovered at runtime, so the spec is not pinned to one instance's data.
    // Read through the app's own configured base URL rather than a port literal.
    const projects = await page.evaluate(async () => {
      const res = await fetch(`${window.__API_URL__}/api/v1/graph/project`);
      const body = (await res.json()) as { data?: Array<{ id: string; name: string }> };
      return (body.data ?? [])
        .filter((p) => p.name && !p.name.includes('/') && p.name.length < 24)
        .slice(0, 2)
        .map((p) => ({ id: p.id, name: p.name }));
    });
    expect(projects.length, 'need two named projects to prove a switch').toBe(2);

    for (const project of projects) {
      await page.goto(`/?scope-mode=project&scope-activeProjectId=${project.id}`);
      await expect(page.getByTestId('footer')).toContainText(project.name);
    }
  });
});

test.describe('the hub home is not collapsed', () => {
  /**
   * `page=hub` is deliberately excluded from `isRootAddress`: `/dock/hub/home` is
   * the hub's OWN home, a separate surface, and collapsing it to `/` would send
   * hub users to the desk. This asserts the URL fact only — hub RENDERING is a
   * different runtime (`vite --mode hubtest` against the hub server) and is not
   * what this change touches.
   */
  test('`/dock/hub/home` keeps its address', async () => {
    await page.goto('/dock/hub/home');
    await expect.poll(() => here()).toContain('/dock/hub/home');
  });
});

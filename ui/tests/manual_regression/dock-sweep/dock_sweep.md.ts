/**
 * Dock sweep — see dock_sweep.md.
 *
 * Every agent-addressable screen, in every shipped view mode, driven through
 * the REAL control plane (`flow navigate view` as a subprocess) rather than
 * `page.goto`. The api-tier sweep proves the address is CARRIED; this proves
 * the dock it names RENDERS.
 *
 * ONE rule, not a taxonomy: ask the control plane, then assert what it said.
 *
 *   exit 0 → the address resolved; the dock must render in every mode.
 *   exit 4 → its referent does not exist here; the browser must NOT move.
 *
 * The fixture's ids are illustrative by design — it pins URL grammar, not a
 * populated instance — so both outcomes are expected and both are meaningful.
 * Deriving which is which from the CLI's own exit code (rather than from a copy
 * of the backend's entity rules) is what keeps this test from drifting away
 * from the thing it tests.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { expect, test } from '@playwright/test';
import { withViewMode, type QaViewMode } from '../_shared/view-mode';
import { apiOrigin } from '../_shared/api';

// ESM scope: no `__dirname`. Derive it from this module's own URL.
const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(HERE, '../../../..');
const INSTANCE = process.env.FLOW_INSTANCE || 'dock7';
// Resolve the backend the way every other manual-regression file does
// (FLOW_INSTANCE -> .env.<instance>.local, then LOCAL_SERVER_PORT). A literal
// port here silently pointed the sweep at whatever happened to own :6007.
const BACKEND = process.env.DOCK_SWEEP_BACKEND || apiOrigin();

// Read rather than `import`: Playwright runs these as ESM, where a JSON import
// needs an import attribute Node's loader rejects here.
const contract = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/dock_address_contract.json'), 'utf8'),
) as { url_cases: UrlCase[] };

/** The three shipped surfaces. `dev` is a hidden developer skin, not a path. */
const MODES: QaViewMode[] = ['vibe', 'standard', 'advanced'];

/**
 * Exceptions this HEADLESS environment produces regardless of app correctness:
 * Chromium without a GPU returns null from `getContext('webgl')`, so every
 * WebGL-backed graph view throws on `getParameter`. Filtered narrowly, so a
 * real exception in those views still fails.
 */
const HEADLESS_WEBGL = /getParameter|WebGL|webgl/;

type UrlCase = {
  name: string;
  view_type: string;
  pointer?: string;
  options?: Record<string, string>;
  layout?: string;
  page?: string;
  base?: string;
  url: string;
};

function addressOf(c: UrlCase): string {
  const query = c.options
    ? `?${Object.entries(c.options)
        .map(([k, v]) => `${k}=${v}`)
        .join('&')}`
    : '';
  return `${c.view_type}${c.pointer ? `/${c.pointer}` : ''}${query}`;
}

const cases = contract.url_cases.filter(
  (c) => !c.base && (c.layout ?? 'dock') === 'dock' && (c.page ?? 'desk') === 'desk',
);

/** Run a flow CLI verb against the sweep instance. */
function flow(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('uv', ['run', 'flow', ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, FLOW_INSTANCE: INSTANCE },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { code: 0, out };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test.describe('dock sweep', () => {
  test.beforeAll(() => {
    // Fail loudly rather than sweep against the wrong (or no) backend.
    const probe = flow(['schema', 'views']);
    expect(probe.code, `flow schema views failed on instance '${INSTANCE}': ${probe.out}`).toBe(0);
    expect(cases.length).toBeGreaterThan(20);
  });

  for (const c of cases) {
    test(`${c.view_type}: ${c.name}`, async ({ page }) => {
      const address = addressOf(c);
      const exceptions: string[] = [];
      const badResponses: string[] = [];
      page.on('pageerror', (e) => exceptions.push(e.message));
      page.on('response', (r) => {
        if (r.status() >= 400 && r.url().includes('/api/v1/')) badResponses.push(`${r.status()} ${r.url()}`);
      });

      for (const mode of MODES) {
        // Park somewhere neutral IN THE REQUESTED MODE first, so the tab this
        // navigate steers is the one under test. instance_ctl seeds `vibe`, so
        // the mode is always set explicitly and never inherited.
        await page.goto(withViewMode('/dock/desktop', mode));
        await expect(page.locator('html')).toHaveAttribute('data-view', mode);
        // `data-view` proves the page rendered, not that the backend can steer
        // it: a navigate targets the tab's WebSocket registration, which lands
        // after first paint, and the previous case just closed its own page.
        // Ask the control plane the same question `flow context` asks and only
        // proceed once it names an active tab.
        await expect
          .poll(async () => (await fetch(`${BACKEND}/api/v1/agent/context`)).status, { timeout: 15_000 })
          .toBe(200);

        const res = flow(['navigate', 'view', address]);

        if (res.code === 4) {
          // The guard, from the outside: an address naming something that does
          // not exist is refused, and the user stays where they were.
          await expect.poll(() => new URL(page.url()).pathname).toContain('/desktop');
          continue;
        }

        expect(res.code, `flow navigate view ${address} [${mode}] → ${res.out}`).toBe(0);
        // The view type is the stable part of the URL; pointers get
        // canonicalized (scope seeding, redirects), so asserting the whole path
        // would be brittle.
        await expect
          .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
          .toContain(`/${c.view_type}`);
        await expect(page.getByTestId('dock-load-error')).toHaveCount(0);
        await expect(page.locator('html')).toHaveAttribute('data-view', mode);
      }

      expect(
        exceptions.filter((e) => !HEADLESS_WEBGL.test(e)),
        `uncaught exceptions for ${address}`,
      ).toEqual([]);
      // Only a POINTERLESS address names nothing external, so only it has
      // nothing legitimate to 404 on. A pointer-bearing address refers to
      // content the fixture invents, and its absence is correct behaviour.
      if (!c.pointer) {
        expect(badResponses, `failed API requests for ${address}`).toEqual([]);
      }
    });
  }

  test('show mints a tab exactly when can_be_tab says so', () => {
    // `flow show` is process-scoped by contract, so it needs a process to
    // belong to — the same one a worker would be running inside.
    const created = execFileSync(
      'curl',
      [
        '-s',
        '-X',
        'POST',
        `${BACKEND}/api/v1/graph/agentic_process`,
        '-H',
        'Content-Type: application/json',
        '-d',
        '{"pty_mode": false, "visible": false}',
      ],
      { encoding: 'utf8' },
    );
    const processId = (JSON.parse(created).data || {}).id as string;
    expect(processId, `could not create a process on ${BACKEND}: ${created}`).toBeTruthy();

    const views = JSON.parse(flow(['schema', 'views']).out) as {
      views: Array<{ view_type: string; can_be_tab: boolean }>;
    };
    const byView = new Map(views.views.map((v) => [v.view_type, v]));

    for (const c of cases) {
      const res = flow(['show', 'view', addressOf(c), '--process', processId]);
      if (res.code === 4) continue; // referent absent — covered above
      expect(res.code, `flow show view ${addressOf(c)} → ${res.out}`).toBe(0);
      expect(byView.get(c.view_type)?.can_be_tab, `${c.view_type} can_be_tab`).toBe(true);
    }
  });
});

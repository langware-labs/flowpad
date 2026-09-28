/**
 * A real world for browser navigation specs (docs/navigation/dock-loading.md):
 * a project with a markdown report, a PTY agentic process running the MOCK
 * worker, and a plain shell — all created through the HTTP API on a disposable
 * instance, and driven in-app through the real control plane (`flow navigate`).
 *
 * The instance must be launched with the mock worker first on PATH so the
 * process's terminal runs a scripted program instead of an LLM:
 *
 *   PATH=$PWD/tests/fixtures/mock_worker_bin:$PATH \
 *   SHELL=$PWD/tests/fixtures/mock_worker_shell \
 *     scripts/instance_ctl.sh launch dlm-7
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { expect, type Page } from '@playwright/test';
import { apiOrigin } from '../_shared/api';
import { awaitSteerable as awaitSteerableOn, flow } from '../_shared/control-plane';

export const INSTANCE = process.env.FLOW_INSTANCE || 'dlm-7';
export const BACKEND = apiOrigin();
export const MOCK_MARKER = 'MOCK-WORKER-READY';

export interface World {
  root: string;
  projectId: string;
  processId: string;
  /** The PTY shell the process's terminal attaches to. */
  processShellId: string;
  shellId: string;
  reportPath: string;
}

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  const body = (await res.json()) as { status: string; data: T; message?: string };
  if (body.status !== 'SUCCESS') throw new Error(`API ${res.url} → ${body.message ?? res.status}`);
  return body.data;
}

const post = (route: string, body: unknown) =>
  fetch(`${BACKEND}/api/v1/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export async function createWorld(label: string): Promise<World> {
  const root = mkdtempSync(path.join(tmpdir(), `flowpad-${label}-`));
  const reportPath = path.join(root, 'report.md');
  writeFileSync(reportPath, '# Validation report\n\nEverything the round trip needs.\n');
  const project = await data<{ id: string }>(
    await post('graph/project', { name: path.basename(root), fs_storage_mount_path: root }),
  );
  const proc = await data<{ id: string }>(
    await post('graph/agentic_process', {
      name: `${label} mock session`,
      project_id: project.id,
      workdir: root,
      worker_type: 'claude_code',
      visible: true,
      pty_mode: true,
    }),
  );
  const opened = await data<{ shell_id: string }>(
    await post(`graph/agentic_process/${proc.id}/open`, { visible: true, cols: 120, rows: 30 }),
  );
  // The marker must be on the recording before any browser attaches, or a
  // "missing marker" could be a slow worker rather than a lost terminal.
  await expect
    .poll(
      // `ptyText` fetches the recording and answers '' when the route does not, so
      // asking it is the whole question — a second fetch downloaded the recording
      // (which the cold-open case grows past 10 MB) once more per poll.
      async () => (await ptyText(opened.shell_id)).includes(MOCK_MARKER),
      {
        timeout: 15_000,
        message: 'the mock worker never printed its marker — is the instance launched with mock_worker_bin on PATH?',
      },
    )
    .toBe(true);
  const shell = await data<{ id: string }>(
    await post('graph/shell', { name: `${label} plain shell`, project_id: project.id, workdir: root }),
  );
  return {
    root,
    projectId: project.id,
    processId: proc.id,
    processShellId: opened.shell_id,
    shellId: shell.id,
    reportPath,
  };
}

/** The recorded PTY output of a shell, decoded. */
export async function ptyText(shellId: string): Promise<string> {
  const r = await fetch(`${BACKEND}/api/v1/shell/${shellId}/pty-stream`);
  if (!r.ok) return '';
  const body = (await r.json()) as { data: { events: [string, string, number][] } };
  return body.data.events
    .filter((e) => e[0] === 'o')
    .map((e) => Buffer.from(e[1], 'base64').toString('utf8'))
    .join('');
}

export async function destroyWorld(world: World): Promise<void> {
  await fetch(`${BACKEND}/api/v1/graph/agentic_process/${world.processId}/exit`, { method: 'POST' }).catch(() => {});
  rmSync(world.root, { recursive: true, force: true });
}

/** Wait until the backend can steer this page (see _shared/control-plane). */
export const awaitSteerable = (page: Page) => awaitSteerableOn(page, BACKEND);

/**
 * Steer the page in-app to a dock address (`<view>/<pointer>?<options>`) and wait
 * until the ROUTER has committed it. The browser URL is not enough: a backend-steered
 * navigate `pushState`s before its loader runs, so a test that moved on at the URL
 * raced a loader still in flight (the next click then superseded it).
 */
export async function navigateTo(page: Page, address: string, expectPath: string): Promise<void> {
  const committedBefore = await committedPaths(page);
  const res = flow(['navigate', 'view', address], INSTANCE);
  expect(res.code, `flow navigate view ${address} → ${res.out}`).toBe(0);
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname), { timeout: 15_000 }).toContain(expectPath);
  if (committedBefore === null) return; // tab_switch tracing is off on this page: the URL is all there is
  await expect
    .poll(
      async () =>
        ((await committedPaths(page)) ?? []).slice(committedBefore.length).some((p) => p.includes(expectPath)),
      {
        timeout: 15_000,
        message: `the router never committed ${expectPath}`,
      },
    )
    .toBe(true);
}

/** Paths of every `committed` tab_switch line so far, or null when the trail is not being recorded. */
async function committedPaths(page: Page): Promise<string[] | null> {
  return page.evaluate(() => {
    const lines = (window as unknown as { __tabSwitchAt?: { line: string }[] }).__tabSwitchAt;
    if (!lines) return null;
    return lines.flatMap((l) => {
      const m = / committed sw=\d+ .* path=(\S+)/.exec(l.line);
      return m ? [decodeURIComponent(m[1])] : [];
    });
  });
}

/**
 * Record, from the first script on the page, every time the "This session has
 * nothing to display" screen appears (either of its two render sites), and the
 * toplog lines the app prints.
 */
export async function installObservers(page: Page): Promise<{ toplog: string[] }> {
  const toplog: string[] = [];
  page.on('console', (m) => {
    const text = m.text();
    if (text.startsWith('[toplog:')) toplog.push(text);
  });
  await page.addInitScript(() => {
    // Opt out of the startup harness-login gate before the app's first script.
    // `useHarnessLoginGate` probes every assistant's sign-in state and auto-opens
    // a MODAL when none is signed in — which is exactly CI, where the mock worker
    // is on PATH but nothing is signed in. Its backdrop then swallows every click
    // in these specs (a tab chip retried for 60s, reported as a hung click).
    // `HARNESS_GATE_SEEN_KEY` exists for this: "a user (or test harness) can opt
    // out of the nag".
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* storage disabled — the gate stays, and the spec will say what covered it */
    }
    const w = window as unknown as {
      __nothingToDisplay: string[];
      __tabSwitchAt: { t: number; line: string }[];
      __apiRequests: { t: number; method: string; path: string }[];
    };
    w.__nothingToDisplay = [];
    // One clock for both: when each tab_switch line was printed, and when each
    // API request was issued — so a request can be placed inside a switch.
    w.__tabSwitchAt = [];
    w.__apiRequests = [];
    const log = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('[toplog:') && args[0].includes('tab_switch')) {
        w.__tabSwitchAt.push({ t: performance.now(), line: args.map(String).join(' ') });
      }
      log(...args);
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-bound with .call below
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      const path = new URL(String(url), location.href).pathname;
      if (path.startsWith('/api/')) w.__apiRequests.push({ t: performance.now(), method, path });
      return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof XMLHttpRequest.prototype.open;
    const check = () => {
      for (const id of ['terminal-panel-error', 'terminal-active-tab-missing']) {
        const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
        if (el && el.offsetParent !== null) w.__nothingToDisplay.push(`${id} @ ${location.pathname}`);
      }
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
  });
  return { toplog };
}

export async function nothingToDisplaySightings(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __nothingToDisplay: string[] }).__nothingToDisplay ?? []);
}

/** Turn toplog tags on for this instance (the page receives the state over its socket). */
export async function toplogOn(tags: string[]): Promise<void> {
  await fetch(`${BACKEND}/api/v1/toplog/enable`, { method: 'POST' });
  await post('toplog/on', { tags });
}

/** The newest tab_switch id this page has logged. */
export async function lastSwitchId(page: Page): Promise<number> {
  return page.evaluate(() => {
    const lines = (window as unknown as { __tabSwitchAt: { line: string }[] }).__tabSwitchAt;
    return Math.max(0, ...lines.map((l) => Number(/sw=(\d+)/.exec(l.line)?.[1] ?? 0)));
  });
}

/**
 * The API requests issued INSIDE each switch's wait — between its `start` line
 * and the dock loader's own `loader` / `loader_redirect` line, i.e. what the URL
 * commit waits on. (The `committed` line trails the new view's first render —
 * the router re-renders from its own subscription first — so it would count the
 * new view's mount effects.)
 */
export async function requestsInsideSwitches(page: Page, afterSwitch = 0): Promise<string[]> {
  const { lines, requests } = await page.evaluate(() => {
    const w = window as unknown as {
      __tabSwitchAt: { t: number; line: string }[];
      __apiRequests: { t: number; method: string; path: string }[];
    };
    return { lines: w.__tabSwitchAt, requests: w.__apiRequests };
  });
  const windows = new Map<string, { start?: number; loaded?: number }>();
  for (const { t, line } of lines) {
    const start = /start sw=(\d+)/.exec(line);
    const loaded = /loader(?:_redirect)? sw=(\d+)/.exec(line);
    const id = start?.[1] ?? loaded?.[1];
    if (!id) continue;
    const w = windows.get(id) ?? {};
    if (start) w.start = t;
    if (loaded && w.loaded === undefined) w.loaded = t;
    windows.set(id, w);
  }
  const inside: string[] = [];
  for (const [id, w] of windows) {
    if (Number(id) <= afterSwitch || w.start === undefined || w.loaded === undefined) continue;
    for (const r of requests) {
      if (r.t < w.start || r.t > w.loaded) continue;
      inside.push(`sw=${id} ${r.method} ${r.path}`);
    }
  }
  return inside;
}

/**
 * Side tests — a page shown in Flowpad reaches its own agentic process through
 * the Flowpad SDK.
 *
 * The contract under test: before a shown page's own scripts run, the host
 * provides two globals —
 *
 *   globalThis.__FLOWPAD_API_URL__   the backend origin (the SDK's existing
 *                                    runtime seam, `ts_sdk/src/config/load_config.ts`)
 *   globalThis.__FLOWPAD_PROCESS_ID__ the agentic process the page is shown beside
 *
 * — and the page can then `import(<api>/sdk/flowpad-sdk.js)`, `initSdk()`, load
 * that process, `setDisplayContext()` and `enqueue()` a prompt into it. The
 * observable effects are read back over HTTP: the prompt in the process queue,
 * and the display context the agent would read (`display-context`, what
 * `flow context display` calls) — fresh and bound to the shown file, and stale
 * once something else is shown. The queue is disabled first so nothing drains
 * and no worker is needed.
 *
 *   1. sandbox contract — the real MCP sandbox proxy, with the CSP opened to the
 *      backend and the globals injected by the harness. Proves the mechanics
 *      work once a host does its part.
 *   2. MCP UI host — `show` a `.mcp.html` on a process and open its Vibe display.
 *   3. HTML host — `show` a plain `.html` on a process and open its Vibe display.
 *
 * 2 and 3 exercise Flowpad's own hosts end to end; they stay red until the hosts
 * pass the CSP and inject the globals.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BE = `http://localhost:${process.env.PSB_BE_PORT || '6007'}`;
const GRAPH = `${BE}/api/v1/graph`;

let dir = '';
const processIds: string[] = [];

async function call(method: 'GET' | 'POST', url: string, body?: unknown): Promise<any> {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await r.json();
  if (json?.status !== 'SUCCESS') throw new Error(`${method} ${url} → ${JSON.stringify(json).slice(0, 300)}`);
  return json.data;
}

/** A fresh, never-launched process whose queue will not drain. */
async function quietProcess(label: string): Promise<string> {
  const created = await call('POST', `${GRAPH}/agentic_process`, { type: 'agentic_process', name: `psb-${label}-${Date.now()}` });
  processIds.push(created.id);
  await call('POST', `${GRAPH}/agentic_process/${created.id}/set-queue-enabled`, { enabled: false });
  return created.id;
}

async function queuedPrompts(processId: string): Promise<string[]> {
  const proc = await call('GET', `${GRAPH}/agentic_process/${processId}`);
  return (proc?.queue?.entries ?? []).map((e: { prompt: string }) => e.prompt);
}

async function displayContext(processId: string): Promise<any> {
  return call('GET', `${GRAPH}/agentic_process/${processId}/display-context`);
}

async function expectFreshContext(processId: string, nonce: string, path: string): Promise<void> {
  await expect
    .poll(async () => {
      const ctx = await displayContext(processId);
      return ctx.fresh ? { nonce: ctx.data?.nonce, path: ctx.target?.path } : null;
    }, { message: `display context ${nonce} never became fresh` })
    .toEqual({ nonce, path });
}

async function expectQueued(processId: string, nonce: string): Promise<void> {
  await expect.poll(() => queuedPrompts(processId), { message: `prompt ${nonce} never reached the queue` }).toContain(nonce);
}

/**
 * The page under test. Uses ONLY the contract globals — no hardcoded backend,
 * no process id baked in. Logs each step with a `[psb]` prefix so a red run
 * says where it stopped.
 */
function probeScript(nonce: string): string {
  return `
(async () => {
  const out = document.getElementById('psb-log');
  const log = (...a) => {
    const line = ['[psb]', ${JSON.stringify(nonce)}, ...a].join(' ');
    console.log(line);
    if (out) out.textContent += line + '\\n';
  };
  try {
    const api = globalThis.__FLOWPAD_API_URL__;
    const pid = globalThis.__FLOWPAD_PROCESS_ID__;
    log('globals', String(api), String(pid), 'origin=' + self.origin);
    if (!api || !pid) throw new Error('host did not provide __FLOWPAD_API_URL__ / __FLOWPAD_PROCESS_ID__');
    const sdk = await import(api + '/sdk/flowpad-sdk.js');
    log('sdk imported');
    await sdk.initSdk();
    log('sdk initialised');
    const proc = await sdk.dataManager.getByTypeId(new sdk.TypeId('agentic_process', pid));
    if (!proc) throw new Error('process not found: ' + pid);
    await proc.enqueue(${JSON.stringify(nonce)}, 'page');
    log('enqueued');
    await proc.setDisplayContext({ nonce: ${JSON.stringify(nonce)}, lesson: 3, results: [true, false] });
    log('display context set');
  } catch (e) {
    log('FAILED', e && e.message ? e.message : String(e));
  }
})();`;
}

function probePage(nonce: string, prelude = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><p>page sdk probe</p><pre id="psb-log"></pre>${prelude}<script type="module">${probeScript(nonce)}</script></body></html>`;
}

/** Collect the probe's `[psb]` lines; `withLog` rethrows a failure with them appended. */
function collectProbeLogs(page: Page): { withLog: (e: Error) => never } {
  const lines: string[] = [];
  page.on('console', (m) => {
    if (m.text().startsWith('[psb]')) lines.push(m.text());
  });
  const withLog = (e: Error): never => {
    throw new Error(
      `${e.message}\n--- probe log ---\n${lines.join('\n') || '(no console lines — see the psb-log block in the page snapshot)'}`,
    );
  };
  return { withLog };
}

test.beforeAll(async () => {
  try {
    const h = await fetch(`${BE}/api/v1/health/status`, { signal: AbortSignal.timeout(2000) });
    if (!h.ok) throw new Error('unhealthy');
  } catch {
    test.skip(true, `backend not up on ${BE} — launch a disposable instance first`);
  }
  dir = mkdtempSync(join(tmpdir(), 'page-sdk-bridge-'));
});

test.afterAll(async () => {
  for (const id of processIds) {
    try {
      await fetch(`${GRAPH}/agentic_process/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(20_000) });
    } catch {
      /* best effort — the instance is disposable */
    }
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frames have no storage */
    }
  });
});

test('sandbox contract: an MCP sandbox page with the backend CSP and injected globals reaches its process', async ({ page }) => {
  const processId = await quietProcess('sandbox');
  const nonce = `PSB_SANDBOX_${Date.now()}`;
  const { withLog } = collectProbeLogs(page);
  // A display context is bound to what is shown; give the process a target.
  const shownFile = join(dir, `${Date.now()}-sandbox.mcp.html`);
  writeFileSync(shownFile, '<html><head></head><body>shown</body></html>');
  // The server resolves the path (on macOS /var → /private/var); compare to its answer.
  const shown = (await call('POST', `${GRAPH}/agentic_process/${processId}/show`, { path: shownFile })).path;

  // A document on the backend origin plays the host, exactly as McpAppPreview
  // would: load the proxy, wait for proxy-ready, hand it the page.
  await page.goto(`${BE}/api/v1/health/status`);
  const prelude = `<script>globalThis.__FLOWPAD_API_URL__=${JSON.stringify(BE)};globalThis.__FLOWPAD_PROCESS_ID__=${JSON.stringify(processId)};</script>`;
  const html = probePage(nonce, prelude);
  await page.evaluate(
    async ({ be, html }) => {
      const csp = { connectDomains: [be, be.replace(/^http/, 'ws')], resourceDomains: [be] };
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
      frame.src = `${be}/mcp-sandbox/sandbox_proxy.html?csp=${encodeURIComponent(JSON.stringify(csp))}`;
      window.addEventListener('message', (event) => {
        if (event.source !== frame.contentWindow) return;
        if (event.data?.method === 'ui/notifications/sandbox-proxy-ready') {
          frame.contentWindow!.postMessage(
            { jsonrpc: '2.0', method: 'ui/notifications/sandbox-resource-ready', params: { html, csp } },
            '*',
          );
        }
      });
      document.body.appendChild(frame);
    },
    { be: BE, html },
  );

  await expectQueued(processId, nonce).catch(withLog);
  await expectFreshContext(processId, nonce, shown).catch(withLog);
});

for (const host of [
  { name: 'MCP UI host', file: 'probe.mcp.html' },
  { name: 'HTML host', file: 'probe.html' },
]) {
  test(`${host.name}: a page shown beside a process reaches it through the SDK`, async ({ page }) => {
    const processId = await quietProcess(host.file.replace(/\W/g, '-'));
    const nonce = `PSB_${host.file.replace(/\W/g, '_').toUpperCase()}_${Date.now()}`;
    const path = join(dir, `${Date.now()}-${host.file}`);
    writeFileSync(path, probePage(nonce));
    const { withLog } = collectProbeLogs(page);

    const shownPath = (await call('POST', `${GRAPH}/agentic_process/${processId}/show`, { path })).path;
    await page.goto(`/dock/shell/agentic_process-${processId}?viewMode=vibe`);

    // enqueue: the page can wake the agent.
    await expectQueued(processId, nonce).catch(withLog);
    // setDisplayContext: the agent can read what the page reported, bound to this file.
    await expectFreshContext(processId, nonce, shownPath).catch(withLog);

    // Showing something else: the old page no longer speaks for the display.
    const other = join(dir, `${Date.now()}-other.html`);
    writeFileSync(other, '<html><head></head><body>other</body></html>');
    await call('POST', `${GRAPH}/agentic_process/${processId}/show`, { path: other });
    await expect.poll(async () => (await displayContext(processId)).fresh).toBe(false);
  });
}

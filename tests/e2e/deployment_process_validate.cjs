/**
 * Real-time browser validation of a local deployment's process panel: the terminal its Python file
 * runs in, live, and the file itself. Headless Playwright, recorded to video; every step is checked
 * against what the PAGE shows (the terminal's rows, the header's state) and timed.
 *
 *   node tests/e2e/deployment_process_validate.cjs <frontend> <backend> <agent id> <deployment id> <out dir> [phase…]
 *
 * Phases (default: all but after-restart, in order):
 *   console        the terminal shows the running loop (its pid line) on open
 *   live           a chat: "← http_chat", "▶ turn", "→ http_chat" appear in the terminal as it happens
 *   edit           Code tab: add a print, Saved, Restart → the terminal shows the new line, a new pid
 *   ctrl-c         Ctrl-C typed in the terminal stops the loop; the app runs it again
 *   pause          Pause → Stopped; Resume → Running again
 *   after-restart  (after the backend restarted) a new terminal runs the file; a chat is answered
 *
 * Writes <out>/report.json, shots/<phase>-*.png and the video. Exits non-zero on a failed check.
 */
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { chromium } = require('../../ui/node_modules/playwright');

const [frontend, backend, agentId, deploymentId, out, ...wanted] = process.argv.slice(2);
if (!out) throw new Error('usage: deployment_process_validate.cjs <frontend> <backend> <agent id> <deployment id> <out dir> [phase…]');
const phases = wanted.length ? wanted : ['console', 'live', 'edit', 'ctrl-c', 'pause'];
mkdirSync(join(out, 'shots'), { recursive: true });
const pageUrl = `${frontend}/dock/assets/editor/agent/typeid/agent-${agentId}/child/deployment/deployment-${deploymentId}`;
const EDIT_LINE = 'print("hello from the edited loop", flush=True)';

const report = { deploymentId, started: new Date().toISOString(), checks: [] };
const t0 = Date.now();
const since = () => ((Date.now() - t0) / 1000).toFixed(1);

async function api(method, path, body) {
  const r = await fetch(`${backend}/api/v1${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json();
  if (!r.ok || json.status === 'FAIL') throw new Error(`${method} ${path}: ${r.status} ${json.message}`);
  return json.data;
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: join(out, 'video'), size: { width: 1440, height: 900 } } });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
      localStorage.removeItem('deployment-process-panel-minimized');
    } catch { /* sandboxed */ }
  });
  const page = await context.newPage();
  let failed = 0;

  /** The terminal's visible rows, one string per row. */
  const consoleRows = () => page.$$eval('[data-testid=deployment-process-panel] .xterm-rows > div', (rows) => rows.map((r) => r.textContent.trimEnd()));
  /** The terminal's text as one run: its rows are WRAPPED lines, so a long line (a pid line, a nonce)
   *  can be split across two — matched across them, not per row. */
  const consoleText = async () => (await consoleRows()).join('');
  const state = () => page.textContent('[data-testid=deployment-process-state]');
  /** How many times the loop said it stopped — a check waits for ONE MORE, not for an old line. */
  const stops = async () => (await consoleText()).split(': stopped').length - 1;

  /** Wait until *predicate* holds (polling the page), recording how long it took; a miss is a failed check. */
  async function expectWithin(phase, what, seconds, predicate) {
    const start = Date.now();
    while (Date.now() - start < seconds * 1000) {
      if (await predicate()) {
        const took = (Date.now() - start) / 1000;
        report.checks.push({ phase, what, ok: true, seconds: took, at: since() });
        console.log(JSON.stringify({ t: since(), phase, ok: what, seconds: took }));
        return true;
      }
      await page.waitForTimeout(250);
    }
    failed++;
    const tail = (await consoleRows()).join('\n').slice(-800);
    report.checks.push({ phase, what, ok: false, seconds, at: since(), console: tail });
    console.log(JSON.stringify({ t: since(), phase, FAILED: what, console: tail }));
    await page.screenshot({ path: join(out, 'shots', `${phase}-FAILED.png`) });
    return false;
  }
  const shot = (name) => page.screenshot({ path: join(out, 'shots', `${name}.png`) });

  async function chat(text) {
    const endpoints = await api('GET', `/graph/deployment/${deploymentId}/endpoints`);
    const rows = Array.isArray(endpoints) ? endpoints : endpoints.endpoints || endpoints.items || [];
    const chatEndpoint = rows.find((e) => e.name === 'chat');
    const r = await fetch(`${backend}/api/v1/graph/service_endpoint/${chatEndpoint.id}/service/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'agent', messages: [{ role: 'user', content: text }] }),
    });
    return (await r.json()).choices?.[0]?.message?.content ?? '';
  }

  await page.goto(pageUrl);
  await page.waitForSelector('[data-testid=deployment-process-panel]', { timeout: 60000 });
  const original = (await api('GET', `/graph/deployment/${deploymentId}/code`)).text;

  try {
    if (phases.includes('console')) {
      await expectWithin('console', 'the header says it runs', 15, async () => /Running · pid \d+/.test(await state()));
      await expectWithin('console', 'the terminal shows the running loop', 20, async () => /pid \d+, instance/.test(await consoleText()));
      await shot('console');
    }

    if (phases.includes('live')) {
      const nonce = Math.random().toString(36).slice(2, 7);
      const answer = chat(`Reply with exactly: console ${nonce}`);
      await expectWithin('live', 'the message in, as it arrives', 15, async () => (await consoleText()).includes(`← http_chat`) && (await consoleText()).includes(nonce));
      await expectWithin('live', 'the turn starting', 15, async () => /▶ turn/.test(await consoleText()));
      await expectWithin('live', 'the reply, as it is sent', 90, async () => new RegExp(`→ http_chat[^←▶→]*console ${nonce}`).test(await consoleText()));
      report.liveAnswer = await answer;
      await shot('live');
    }

    if (phases.includes('edit')) {
      const pidBefore = (await state()).match(/pid (\d+)/)?.[1];
      await page.click('[data-testid=deployment-process-tab-code]');
      await page.waitForSelector('[data-testid=deployment-process-code] .monaco-editor', { timeout: 30000 });
      await page.click('[data-testid=deployment-process-code] .monaco-editor .view-lines');
      // At the top: the loop's own call blocks, so a line after it would print only on exit.
      await page.keyboard.press('Meta+ArrowUp');
      await page.keyboard.press('Home');
      await page.keyboard.type(EDIT_LINE);
      await page.keyboard.press('Enter');
      await expectWithin('edit', 'the edit is saved', 10, async () => (await page.textContent('[data-testid=deployment-process-code-state]')).startsWith('Saved'));
      const saved = (await api('GET', `/graph/deployment/${deploymentId}/code`)).text;
      await expectWithin('edit', 'the file on disk has the edit', 2, async () => saved.includes('hello from the edited loop'));
      await shot('edit-code');
      await page.click('[data-testid=deployment-process-restart]');
      await expectWithin('edit', 'Restart shows the console', 5, async () => (await page.$('[data-testid=deployment-process-panel] .xterm')) !== null);
      await expectWithin('edit', 'the edited loop prints its line', 30, async () => (await consoleText()).includes('hello from the edited loop'));
      await expectWithin('edit', 'it runs again, as a new process', 30, async () => {
        const pid = (await state()).match(/pid (\d+)/)?.[1];
        return Boolean(pid) && pid !== pidBefore;
      });
      await shot('edit-restarted');
      const nonce = Math.random().toString(36).slice(2, 7);
      const answered = await chat(`Reply with exactly: edited ${nonce}`);
      await expectWithin('edit', 'the edited loop answers', 2, async () => answered.includes(nonce));
    }

    if (phases.includes('ctrl-c')) {
      const pidBefore = (await state()).match(/pid (\d+)/)?.[1];
      const stopped = await stops();
      await page.click('[data-testid=deployment-process-panel] .xterm-screen');
      await page.keyboard.press('Control+c');
      await expectWithin('ctrl-c', 'the loop says it stopped', 10, async () => (await stops()) > stopped);
      await shot('ctrl-c-stopped');
      await expectWithin('ctrl-c', 'the app runs it again', 30, async () => {
        const pid = (await state()).match(/pid (\d+)/)?.[1];
        return Boolean(pid) && pid !== pidBefore;
      });
      await shot('ctrl-c-running-again');
    }

    if (phases.includes('pause')) {
      const stopped = await stops();
      await api('POST', `/graph/deployment/${deploymentId}/pause`);
      await expectWithin('pause', 'Pause: the header says stopped', 15, async () => /Stopped/.test(await state()));
      await expectWithin('pause', 'Pause: the terminal shows it ended', 10, async () => (await stops()) > stopped);
      await shot('paused');
      await api('POST', `/graph/deployment/${deploymentId}/resume`);
      await expectWithin('pause', 'Resume: running again', 30, async () => /Running · pid \d+/.test(await state()));
      await shot('resumed');
    }

    if (phases.includes('after-restart')) {
      await expectWithin('after-restart', 'a new terminal runs the file', 45, async () => /Running · pid \d+/.test(await state()) && /pid \d+, instance/.test(await consoleText()));
      const nonce = Math.random().toString(36).slice(2, 7);
      const answered = await chat(`Reply with exactly: back ${nonce}`);
      await expectWithin('after-restart', 'a chat is answered after the restart', 2, async () => answered.includes(nonce));
      await expectWithin('after-restart', 'and the terminal shows it', 15, async () => (await consoleText()).includes(nonce));
      await shot('after-restart');
    }
  } catch (error) {
    failed++;
    report.error = String(error);
    console.log(JSON.stringify({ t: since(), ERROR: String(error) }));
  } finally {
    if (phases.includes('edit')) await api('POST', `/graph/deployment/${deploymentId}/save_code`, { text: original }).catch(() => undefined);
    report.finished = new Date().toISOString();
    report.failed = failed;
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
    await context.close();
    await browser.close();
    console.log(JSON.stringify({ t: since(), done: true, failed }));
    process.exit(failed ? 1 : 0);
  }
})().catch((error) => {
  console.error(error);
  process.exit(2);
});

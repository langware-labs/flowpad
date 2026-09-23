/**
 * Watch a deployment's page in a real browser while its agent works: a video of the whole run, a
 * screenshot of the thread list every few seconds (with each thread's status as the page shows it),
 * and — once the run is over — each thread opened, its events screenshotted.
 *
 *   node tests/e2e/deployment_page_watch.cjs <frontend> <agent id> <deployment id> <out dir> <stop file>
 *
 * Runs until <stop file> exists. Writes <out dir>/timeline.jsonl (what the page listed, when),
 * shots/*.png, threads/*.png and the video. Uses ui/node_modules/playwright.
 */
const { mkdirSync, existsSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');
const { chromium } = require('../../ui/node_modules/playwright');

(async () => {

const [frontend, agentId, deploymentId, out, stopFile] = process.argv.slice(2);
if (!stopFile) throw new Error('usage: deployment_page_watch.cjs <frontend> <agent id> <deployment id> <out dir> <stop file>');
for (const dir of ['shots', 'threads', 'video']) mkdirSync(join(out, dir), { recursive: true });

const url = `${frontend}/dock/assets/editor/agent/typeid/agent-${agentId}/child/deployment/deployment-${deploymentId}`;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: join(out, 'video'), size: { width: 1440, height: 900 } } });
await context.addInitScript(() => {
  try {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  } catch {
    /* sandboxed */
  }
});
const page = await context.newPage();
await page.goto(url);
await page.waitForSelector('[data-testid=agent-deployment-page]', { timeout: 60000 });

const rows = () =>
  page.$$eval('[data-testid^=deployment-thread-][data-status]', (els) =>
    els.map((e) => ({ id: e.dataset.testid.replace('deployment-thread-', ''), status: e.dataset.status, text: e.innerText.replace(/\n/g, ' / ').slice(0, 120) })),
  );

let n = 0;
while (!existsSync(stopFile)) {
  const listed = await rows();
  appendFileSync(join(out, 'timeline.jsonl'), JSON.stringify({ t: new Date().toISOString(), threads: listed }) + '\n');
  await page.screenshot({ path: join(out, 'shots', `${String(n++).padStart(3, '0')}.png`) });
  await page.waitForTimeout(5000);
}

// The run is over: open each thread the way a person does (a click), and keep its events.
const final = await rows();
for (const [i, thread] of final.entries()) {
  await page.click(`[data-testid="deployment-thread-${thread.id}"]`);
  await page.waitForSelector('[data-testid=thread-events] [data-testid^=thread-event-]', { timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  const events = await page.$$eval('[data-testid=thread-events] [data-testid^=thread-event-]', (els) => els.map((e) => e.dataset.testid.replace('thread-event-', '')));
  appendFileSync(join(out, 'threads.jsonl'), JSON.stringify({ ...thread, events }) + '\n');
  await page.screenshot({ path: join(out, 'threads', `${String(i).padStart(2, '0')}.png`) });
}
await context.close();
await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

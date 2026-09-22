/**
 * Drive one ask window the way a person would, and say what happened.
 *
 * Node rather than Python because the repo already has @playwright/test and its
 * chromium; adding a second Playwright to the Python side would mean a new
 * dependency and a re-lock for a browser that is already on disk.
 *
 * Usage:  node drive_ask.mjs <url> answer <value> | cancel
 * Exits 0 when the page accepted the action, non-zero with a reason otherwise.
 */
import { chromium } from 'playwright';

const [url, action, value] = process.argv.slice(2);
if (!url || !action) {
  console.error('usage: drive_ask.mjs <url> answer <value> | cancel');
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
// Declared out here so the failure path can report them too — a diagnostic
// that only exists on the happy path is no diagnostic at all.
// Two buckets, deliberately: an uncaught exception means the page is broken
// and fails the run; a console error is reported and judged by the caller.
const problems = [];
const consoleErrors = [];
const calls = [];
let page = null;
try {
  page = await browser.newPage();
  // Every call the page makes to the ask API, with its outcome. "No settled
  // message and no error" can mean the request was never sent, or was sent and
  // never answered — and those are different bugs.
  page.on('request', (r) => r.url().includes('/api/v1/ask') && calls.push(`-> ${r.method()} ${r.url()}`));
  page.on('response', (r) => r.url().includes('/api/v1/ask') && calls.push(`<- ${r.status()} ${r.url()}`));
  page.on('requestfailed', (r) => r.url().includes('/api/v1/ask') && calls.push(`xx ${r.url()} ${r.failure()?.errorText}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // `win/` is chrome-less but still mounts the whole app, so an app-level
  // dialog (login, onboarding) can sit on top of the question. Report what it
  // was — a question nobody can click is worth naming, not silently dismissing.
  // Report it, do not fight it. Neither Escape nor its own Close dismisses
  // this one, which is why the interaction below dispatches on the element
  // instead of clicking through. Naming what covered the question is the
  // useful part; pretending to close it was not.
  const dialog = page.locator('[role="dialog"]').first();
  const covered = (await dialog.count())
    ? (await dialog.innerText()).slice(0, 120).replace(/\s+/g, ' ')
    : null;

  // The question must actually render. A blank window is the failure this
  // whole test exists to catch, so wait for the prompt, not for the network.
  await page.getByTestId('ask-view').waitFor({ state: 'visible', timeout: 20_000 });
  const prompt = await page.getByTestId('ask-prompt').textContent();

  // Keyboard, not mouse. In a fresh profile the app floats its own assistant
  // window over everything, and a click would be hit-tested against that
  // rather than against the question. Focus + Enter runs the SAME handlers a
  // person's click runs — it just cannot be intercepted by an overlay.
  // dispatchEvent, not click(): in a fresh profile the app floats its own
  // assistant window over everything, and even a forced click is routed to
  // whatever is topmost at those coordinates. Dispatching on the element
  // delivers a real DOM click event to the real React handler — what is under
  // test is the handler, not the browser's hit-testing.
  if (action === 'answer') {
    const field = page.locator('[data-testid^="ask-input-"]').first();
    await field.fill(value ?? '');
    await page.getByTestId('ask-submit').dispatchEvent('click');
  } else {
    await page.getByTestId('ask-cancel').dispatchEvent('click');
  }

  // The window says it is done. Until it does, the op has not been told.
  await page.getByTestId('ask-settled').waitFor({ state: 'visible', timeout: 20_000 });
  const settled = await page.getByTestId('ask-settled').textContent();

  console.log(JSON.stringify({ ok: true, prompt, settled, covered, calls, problems, consoleErrors }));
  process.exit(problems.length ? 3 : 0);
} catch (reason) {
  // What was actually on screen. A timeout with no picture of the page is a
  // guess; this makes the next step a reading rather than a hypothesis.
  let seen = null;
  try {
    if (page) {
      await page.screenshot({ path: '/tmp/ask_window.png', fullPage: true });
      const dialog = page.locator('[role="dialog"]').first();
      seen = {
        dialog: (await dialog.count()) ? (await dialog.innerText()).slice(0, 300) : null,
        body: (await page.locator('body').innerText()).slice(0, 400),
        shot: '/tmp/ask_window.png',
      };
    }
  } catch { /* the page is gone; the error below is still the answer */ }
  console.log(JSON.stringify({ ok: false, error: String(reason).slice(0, 300), calls, consoleErrors, seen }));
  process.exit(1);
} finally {
  await browser.close();
}

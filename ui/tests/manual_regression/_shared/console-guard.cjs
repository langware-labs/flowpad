/**
 * Console-error gate for the Phase 11 Playwright sweep.
 *
 * Loaded via NODE_OPTIONS=--require, so it is installed in the Playwright test
 * runner AND in every worker process without touching a single test file.
 *
 * It patches BrowserContext#_onPage — the one seam every page (fixture page,
 * manually created page, popup) passes through — and attaches `console` and
 * `pageerror` listeners. Attaching a `console` listener is also what makes
 * Playwright subscribe to console events on the server side at all
 * (see _setEventToSubscriptionMapping in client/page.js), so without this the
 * messages are never even transmitted.
 *
 * Every error-level message is appended as one JSON line to $PW_CONSOLE_SINK.
 * The sweep driver treats a non-empty sink as a failure for that file.
 */
const fs = require('fs');
const path = require('path');

const SINK = process.env.PW_CONSOLE_SINK;
if (SINK) {
  const CORE = path.join(__dirname, '..', '..', '..', 'node_modules', 'playwright-core', 'lib', 'client', 'browserContext.js');
  try {
    const mod = require(CORE);
    const BrowserContext = mod.BrowserContext;
    if (BrowserContext && BrowserContext.prototype && !BrowserContext.prototype.__consoleGuardInstalled) {
      BrowserContext.prototype.__consoleGuardInstalled = true;

      const record = (entry) => {
        try {
          fs.appendFileSync(SINK, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
        } catch { /* sink is best-effort; never break a test */ }
      };

      const attach = (page) => {
        page.on('console', (msg) => {
          let type;
          try { type = msg.type(); } catch { return; }
          if (type !== 'error') return;
          let text = '', url = '', location = null;
          try { text = msg.text(); } catch {}
          try { url = page.url(); } catch {}
          try { location = msg.location(); } catch {}
          record({ kind: 'console.error', text, page_url: url, location });
        });
        page.on('pageerror', (err) => {
          let url = '';
          try { url = page.url(); } catch {}
          record({
            kind: 'pageerror',
            text: String((err && err.message) || err),
            stack: (err && err.stack) ? String(err.stack).split('\n').slice(0, 12).join('\n') : null,
            page_url: url,
          });
        });
      };

      const orig = BrowserContext.prototype._onPage;
      BrowserContext.prototype._onPage = function (page) {
        try { attach(page); } catch { /* never break page creation */ }
        return orig.call(this, page);
      };
    }
  } catch (e) {
    // Make an install failure LOUD — a silently-uninstalled guard would report
    // "no console errors" for every file, which is worse than no gate at all.
    process.stderr.write('[console-guard] INSTALL FAILED: ' + (e && e.stack || e) + '\n');
    try { fs.appendFileSync(SINK, JSON.stringify({ kind: 'guard.install_failed', text: String(e && e.message || e) }) + '\n'); } catch {}
  }
}

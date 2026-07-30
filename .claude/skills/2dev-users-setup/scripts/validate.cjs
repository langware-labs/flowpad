// Validate both browsers: each page queries ITS OWN backend, and we read the
// rendered UI too — the backend API alone does not prove what the window shows.
//
// Usage: node validate.cjs [be_a] [be_b]
//   e.g. node "$(dirname .)/validate.cjs" 6001 6002
//
// Invoke with node's absolute nvm path and keep the playwright-core require
// absolute: there is no module resolution from a scratch directory.
const PW = process.env.PLAYWRIGHT_CORE ||
  `${process.env.HOME}/Developer/flowpad/ui/node_modules/playwright-core`;
const { chromium } = require(PW);

const BE_A = process.argv[2] || '6001';
const BE_B = process.argv[3] || '6002';
const SHOT = process.env.SHOT_DIR || '/tmp';

(async () => {
  const rows = [];
  for (const [label, cdp, be] of [['A', 9222, BE_A], ['B', 9223, BE_B]]) {
    const b = await chromium.connectOverCDP(`http://localhost:${cdp}`);
    const page = b.contexts()[0].pages()[0];
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    const info = await page.evaluate(async (p) => {
      const r = await fetch(`http://localhost:${p}/api/v1/cloud/status`);
      const j = await r.json(); const l = j.data.login;
      return { page: location.href, email: l.user?.email, name: l.user?.name,
               id: l.user?.id, status: l.status, conn: j.data.connection?.status,
               ui: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 120) };
    }, be);
    await page.screenshot({ path: `${SHOT}/browser-${label}.png` }).catch(() => {});
    rows.push({ browser: label, backend: be, ...info });
    // Deliberately no page.close(): closing the last tab exits Chrome.
  }
  console.log(JSON.stringify(rows, null, 2));

  const [a, b] = rows;
  const ok = a.status === 'logged_in' && b.status === 'logged_in' &&
             a.conn === 'connected' && b.conn === 'connected' &&
             a.email && b.email && a.email !== b.email;
  console.log(ok ? '\nPASS — two distinct users, both connected'
                 : '\nFAIL — see rows above (same user? not connected? not logged in?)');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });

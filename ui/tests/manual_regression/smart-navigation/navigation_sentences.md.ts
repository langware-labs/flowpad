/**
 * Every sentence of docs/navigation/navigation-sentences.md, typed into the magic line of a real
 * instance — see ./navigation_sentences.md. Scores each one:
 *   1 works · 2 does not work, can work with the current architecture · 3 impossible (+ reason)
 * and checks that the decision left a SmartNavigationLog row (its example id goes on the board).
 *
 * Ground truth is the backend's: the log row is written after the answer, so its arrival means the
 * decision is done, and its `data.address` / `data.prompt` says what the UI should have done.
 *
 * Writes ui/tests/manual_regression/_results/navigation-scoreboard.{jsonl,md} (git-ignored).
 *
 *   VITE_PORT=5021 FLOW_INSTANCE=nav-7 npx playwright test \
 *     --config tests/manual_regression/smart-navigation/playwright.config.ts navigation_sentences
 */
import { expect, test, type Page } from '@playwright/test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { apiContext, REPO_ROOT } from '../_shared/api';
import { type LogRow, type Row, score, type Verdict } from './navigation_scoring';

const DOC = path.join(REPO_ROOT, 'docs/navigation/navigation-sentences.md');
const OUT = path.join(REPO_ROOT, 'ui/tests/manual_regression/_results');
const JSONL = path.join(OUT, 'navigation-scoreboard.jsonl');


function sentences(): Row[] {
  const text = readFileSync(DOC, 'utf-8');
  const groups = [...text.matchAll(/^### ([A-Z])\. (.+?) \(\d+\)$/gm)].map((m) => ({ at: m.index!, name: `${m[1]}. ${m[2]}` }));
  return [...text.matchAll(/^\| (\d+) \| (.+?) \| (.+?) \|$/gm)].map((m) => ({
    group: groups.filter((g) => g.at < m.index!).at(-1)!.name,
    n: Number(m[1]),
    sentence: m[2].replace(/\s*\(typo\)$/, '').trim(),
    target: m[3].trim(),
  }));
}

/** The SmartNavigationLog dataset's id — '' until the first logged decision creates it. */
async function logDataset(): Promise<string> {
  const api = await apiContext();
  const res = await api.get(`/api/v1/graph/dataset?filter=${encodeURIComponent('{"name":"SmartNavigationLog"}')}`);
  const [row] = ((await res.json()).data ?? []) as { id: string }[];
  return row?.id ?? '';
}

async function logRows(): Promise<LogRow[]> {
  const datasetId = await logDataset();
  if (!datasetId) return [];
  const api = await apiContext();
  return ((await (await api.get(`/api/v1/graph/dataset/${datasetId}/rows`)).json()).data.rows ?? []) as LogRow[];
}

const api = () => apiContext();
const ROWS = sentences();
let page: Page;

test.describe.serial('navigation sentences', () => {
  test.beforeAll(async ({ browser }) => {
    expect(ROWS.length, 'the doc lists 200 sentences').toBe(200);
    mkdirSync(OUT, { recursive: true });
    // NAV_RESUME=1 keeps the rows already run (rerun the rest with -g); otherwise start clean.
    if (!process.env.NAV_RESUME) writeFileSync(JSONL, '');
    page = await browser.newPage();
  });

  for (const r of ROWS) {
    test(`${r.n}. ${r.sentence}`, async () => {
      const seen = new Set((await logRows()).map((x) => x.id));
      await page.goto('/dock/home');
      await expect(page.getByTestId('top-nav-address')).toBeVisible();
      // A `/win/…` page pops out as a window of its own instead of moving this tab.
      let popup: string | undefined;
      const onPopup = (p: Page) =>
        void p
          .waitForURL((u) => u.protocol.startsWith('http'))
          .then(() => (popup = new URL(p.url()).pathname))
          .finally(() => p.close())
          .catch(() => undefined);
      page.on('popup', onPopup);
      await page.getByTestId('top-nav-address').click();
      await page.getByTestId('top-nav-ask-input').fill(r.sentence);
      await page.getByTestId('top-nav-ask-input').press('Enter');

      // The backend writes the log row after it answers: its arrival means the decision is done.
      let log: LogRow | null = null;
      await expect
        .poll(async () => {
          log = (await logRows()).find((x) => !seen.has(x.id) && x.input?.utterance === r.sentence) ?? null;
          return !!log;
        }, { message: 'a SmartNavigationLog row for this sentence' })
        .toBe(true)
        .catch(() => undefined);
      const answered = log as LogRow | null;
      // Then the UI must have done what the row says: navigated to its address, or asked.
      const address: string | undefined = answered?.data?.address;
      await expect
        .poll(async () => {
          const u = new URL(page.url());
          if (address) return u.pathname + u.search === address || u.pathname === address.split('?')[0];
          if (answered?.data?.detail?.startsWith('open /win/')) return popup !== undefined;
          if (answered?.data?.prompt !== undefined) return page.getByTestId('assistant-chat').isVisible();
          return u.pathname !== '/' && !u.pathname.startsWith('/dock/home');
        })
        .toBe(true)
        .catch(() => undefined);

      page.off('popup', onPopup);
      const url = new URL(page.url());
      const asked = answered?.data?.prompt !== undefined;
      const { verdict, reason } = score(r, url, asked, answered, popup);
      const record = {
        ...r,
        verdict,
        reason: answered ? reason : `NO LOG ROW — ${reason}`,
        final: url.pathname + url.search,
        popup: popup ?? null,
        asked,
        log_example: answered?.id ?? null,
        decision: answered?.output ?? null,
        did: answered?.data ?? null,
      };
      appendFileSync(JSONL, JSON.stringify(record) + '\n');
      expect(answered, 'the decision left a SmartNavigationLog row').not.toBeNull();
      if (asked) await page.keyboard.press('Escape');
      // Sentence "log out" really signs the instance out of the hub, which is the decision API's only
      // door: every later sentence would then be decided with no endpoint. Sign back in (env mode, no body).
      const status = await (await api().then((a) => a.get('/api/v1/cloud/status'))).json();
      if (status?.data?.login?.status === 'logged_out') await (await api()).post('/api/v1/cloud/login');
    });
  }

  test.afterAll(() => {
    if (!existsSync(JSONL)) return;
    // Last run of each sentence wins, re-scored with the current rules (so a rule fix re-scores old rows).
    const byN = new Map<number, any>();
    for (const l of readFileSync(JSONL, 'utf-8').trim().split('\n').filter(Boolean)) {
      const x = JSON.parse(l);
      const s = score(x, new URL(x.final, 'http://x'), !!x.asked, x.log_example ? { id: x.log_example, input: {}, output: x.decision, data: x.did } : null, x.popup ?? undefined);
      byN.set(x.n, { ...x, verdict: s.verdict, reason: x.log_example ? s.reason : `NO LOG ROW — ${s.reason}` });
    }
    const recs = [...byN.values()].sort((a, b) => a.n - b.n);
    const groups = [...new Set(recs.map((x) => x.group))];
    const count = (xs: any[], v: Verdict) => xs.filter((x) => x.verdict === v).length;
    const lines = [
      '# Navigation scoreboard',
      '',
      `${recs.length} sentences · 1 works: ${count(recs, 1)} · 2 fixable: ${count(recs, 2)} · 3 impossible: ${count(recs, 3)} · log rows: ${recs.filter((x) => x.log_example).length}`,
      '',
      '| group | 1 works | 2 fixable | 3 impossible |',
      '|---|---|---|---|',
      ...groups.map((g) => {
        const xs = recs.filter((x) => x.group === g);
        return `| ${g} | ${count(xs, 1)} | ${count(xs, 2)} | ${count(xs, 3)} |`;
      }),
      '',
      '| # | sentence | target | score | reason | landed on | log example |',
      '|---|---|---|---|---|---|---|',
      ...recs.map((x) => `| ${x.n} | ${x.sentence} | ${x.target} | ${x.verdict} | ${x.reason} | ${x.final} | ${x.log_example ?? '—'} |`),
      '',
    ];
    writeFileSync(path.join(OUT, 'navigation-scoreboard.md'), lines.join('\n'));
  });
});

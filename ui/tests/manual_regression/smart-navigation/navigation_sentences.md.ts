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

const DOC = path.join(REPO_ROOT, 'docs/navigation/navigation-sentences.md');
const OUT = path.join(REPO_ROOT, 'ui/tests/manual_regression/_results');
const JSONL = path.join(OUT, 'navigation-scoreboard.jsonl');

type Row = { group: string; n: number; sentence: string; target: string };
type LogRow = { id: string; input: any; output: any; data: any };
type Verdict = 1 | 2 | 3;

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

/** Why a target is not an address at all — `navigation.outcome` is a dock OR a prompt. */
const IMPOSSIBLE: [RegExp, string][] = [
  [/new chat|new terminal|fork session/, 'creates a process — an action, not a place'],
  [/history back|history forward|reload/, 'browser history, not a destination'],
  [/theme toggle|logout|open in window/, 'client-side toggle or session action, not a place'],
  [/dialog|quick-create|invite|publish|upload|add dependency|add help desk|add machine|new sandbox|new endpoint|project list|open folder|ask-for-help|assistant chat|bookmarks menu|spotlight|Settings|setup wizard/, 'opens a dialog / panel / menu, which has no address'],
];

/** A screen's bare address opens this tab, so landing on the bare address IS landing on the tab. */
const DEFAULT_TAB: Record<string, string> = {
  '/dock/credentials': '/dock/credentials/connections',
  '/dock/ai-config': '/dock/ai-config/llm-apis',
  '/dock/machine': '/dock/machine/processes',
  '/dock/hub/token-plan': '/dock/hub/token-plan/me',
};

/** What the address must start with: the target up to its first placeholder. */
const prefix = (target: string) => target.split(/[<…( ]/)[0].replace(/\/$/, '');

/** Where an `entity:<type>` / `file:` / `log:` target lands when it works. */
function landedLike(target: string, url: URL): boolean {
  const where = url.pathname + url.search;
  if (target.startsWith('log:')) return /\/dock\/app\/.+subject=dataset-/.test(where);
  if (target.startsWith('file:')) return /\/dock\/(assets\/editor|editor)\//.test(where);
  const type = target.slice('entity:'.length).split(/[ (→]/)[0];
  if (type === 'project') return /\/dock\/(project|assets)/.test(where);
  if (type === 'conversation') return where.startsWith('/dock/conversation/');
  if (type === 'agentic_process') return /\/dock\/(shell|agentic_process|lens)\//.test(where);
  if (type === 'dataset') return /\/dock\/app\/.+subject=dataset-/.test(where);
  if (type === 'data_source') return where.startsWith('/dock/data-sources') || where.includes(`typeid/${type}-`);
  return where.includes(`/assets/editor/`) && (where.includes(`typeid/${type}-`) || where.includes(`/${type}/`));
}

function score(r: Row, url: URL, asked: boolean, log: LogRow | null): { verdict: Verdict; reason: string } {
  const where = url.pathname + url.search;
  const did = asked
    ? `asked the assistant (${log?.data?.reason ?? '?'} ${(log?.output?.confidence ?? 0).toFixed(2)})`
    : `opened ${where}`;
  if (r.target.startsWith('ACTION:')) {
    const what = r.target.slice('ACTION:'.length).trim();
    if (/view mode (\w+)/.test(what)) {
      const mode = what.match(/view mode (\w+)/)![1];
      return url.searchParams.get('viewMode') === mode
        ? { verdict: 1, reason: '' }
        : { verdict: 2, reason: `reachable as ?viewMode=${mode}; ${did}` };
    }
    const hit = IMPOSSIBLE.find(([re]) => re.test(what));
    return { verdict: 3, reason: `${hit ? hit[1] : 'an action, not a place'} — ${did}` };
  }
  if (/^(entity|file|log|url):/.test(r.target)) {
    if (!asked && landedLike(r.target, url)) return { verdict: 1, reason: '' };
    const missing = log?.output?.route === 'agentic' && !(log?.input && r.target.startsWith('log:'));
    return { verdict: 2, reason: `${did}${missing ? ' — the thing may not exist on this instance, or search missed it' : ''}` };
  }
  const want = prefix(r.target);
  if (want === '/dock/home' && url.pathname === '/') return { verdict: 1, reason: '' }; // Home's canonical address
  if (DEFAULT_TAB[url.pathname] && want.startsWith(DEFAULT_TAB[url.pathname])) return { verdict: 1, reason: '' };
  const works = where === want || where.startsWith(want) || url.pathname === want.split('?')[0] && !want.includes('?');
  if (works) return { verdict: 1, reason: '' };
  const needsContext = r.target.includes('<') ? ' — needs "this …" context the Home page does not give' : '';
  const sameView = !asked && url.pathname.split('/')[2] === want.split('/')[2];
  return { verdict: 2, reason: `${sameView ? 'right screen, other tab — ' : ''}${did}${needsContext}` };
}

async function logDataset(): Promise<string> {
  const api = await apiContext();
  const res = await api.get(`/api/v1/graph/dataset?filter=${encodeURIComponent('{"name":"SmartNavigationLog"}')}`);
  const [row] = ((await res.json()).data ?? []) as { id: string }[];
  if (!row) throw new Error('no SmartNavigationLog — turn on Preferences > Advanced > Smart navigation log');
  return row.id;
}

async function logRows(datasetId: string): Promise<LogRow[]> {
  const api = await apiContext();
  return ((await (await api.get(`/api/v1/graph/dataset/${datasetId}/rows`)).json()).data.rows ?? []) as LogRow[];
}

const ROWS = sentences();
let page: Page;
let logId = '';

test.describe.serial('navigation sentences', () => {
  test.beforeAll(async ({ browser }) => {
    expect(ROWS.length, 'the doc lists 200 sentences').toBe(200);
    mkdirSync(OUT, { recursive: true });
    // NAV_RESUME=1 keeps the rows already run (rerun the rest with -g); otherwise start clean.
    if (!process.env.NAV_RESUME) writeFileSync(JSONL, '');
    logId = await logDataset();
    page = await browser.newPage();
  });

  for (const r of ROWS) {
    test(`${r.n}. ${r.sentence}`, async () => {
      const seen = new Set((await logRows(logId)).map((x) => x.id));
      await page.goto('/dock/home');
      await expect(page.getByTestId('top-nav-address')).toBeVisible();
      await page.getByTestId('top-nav-address').click();
      await page.getByTestId('top-nav-ask-input').fill(r.sentence);
      await page.getByTestId('top-nav-ask-input').press('Enter');

      // The backend writes the log row after it answers: its arrival means the decision is done.
      let log: LogRow | null = null;
      await expect
        .poll(async () => {
          log = (await logRows(logId)).find((x) => !seen.has(x.id) && x.input?.utterance === r.sentence) ?? null;
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
          if (answered?.data?.prompt !== undefined) return page.getByTestId('assistant-chat').isVisible();
          return u.pathname !== '/' && !u.pathname.startsWith('/dock/home');
        })
        .toBe(true)
        .catch(() => undefined);

      const url = new URL(page.url());
      const asked = answered?.data?.prompt !== undefined;
      const { verdict, reason } = score(r, url, asked, answered);
      const record = {
        ...r,
        verdict,
        reason: answered ? reason : `NO LOG ROW — ${reason}`,
        final: url.pathname + url.search,
        asked,
        log_example: answered?.id ?? null,
        decision: answered?.output ?? null,
        did: answered?.data ?? null,
      };
      appendFileSync(JSONL, JSON.stringify(record) + '\n');
      expect(answered, 'the decision left a SmartNavigationLog row').not.toBeNull();
      if (asked) await page.keyboard.press('Escape');
    });
  }

  test.afterAll(() => {
    if (!existsSync(JSONL)) return;
    // Last run of each sentence wins, re-scored with the current rules (so a rule fix re-scores old rows).
    const byN = new Map<number, any>();
    for (const l of readFileSync(JSONL, 'utf-8').trim().split('\n').filter(Boolean)) {
      const x = JSON.parse(l);
      const s = score(x, new URL(x.final, 'http://x'), !!x.asked, x.log_example ? { id: x.log_example, input: {}, output: x.decision, data: x.did } : null);
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

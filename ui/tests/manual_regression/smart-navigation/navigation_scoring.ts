/**
 * How ./navigation_sentences.md.ts scores one sentence: 1 works · 2 does not work, can work with the
 * current architecture · 3 impossible (+ reason). No Playwright here, so tests/unit can check it.
 */

export type Row = { group: string; n: number; sentence: string; target: string };
export type LogRow = { id: string; input: any; output: any; data: any };
export type Verdict = 1 | 2 | 3;

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

/** The in-app web view's address for an external URL — ts_sdk's pointerForWebUrl (base64url). */
const webViewOf = (url: string) =>
  `/dock/web-app/url/${btoa(encodeURIComponent(new URL(url).href)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

/** Where an `entity:<type>` / `file:` / `log:` / `url:` target lands when it works. `popup`: the
 *  path of a window the sentence opened (a `/win/…` page pops out instead of moving this tab). */
export function landedLike(target: string, url: URL, popup?: string): boolean {
  const where = url.pathname + url.search;
  if (target.startsWith('url:')) {
    const want = target.slice('url:'.length).trim();
    if (want.startsWith('/')) return popup === want || url.pathname === want;
    return url.pathname === webViewOf(want);
  }
  if (target.startsWith('log:')) return /\/dock\/app\/.+subject=dataset-/.test(where);
  if (target.startsWith('file:')) return /\/dock\/(assets\/editor|editor)\//.test(where);
  const type = target.slice('entity:'.length).split(/[ (→]/)[0];
  if (type === 'project') return /\/dock\/(project|assets)/.test(where);
  if (type === 'conversation') return where.startsWith('/dock/conversation/');
  if (type === 'agentic_process') return /\/dock\/(shell|agentic_process|lens)\//.test(where);
  if (type === 'dataset') return /\/dock\/app\/.+subject=dataset-/.test(where);
  if (type === 'data_source') return where.startsWith('/dock/data-sources') || where.includes(`typeid/${type}-`);
  // An asset opens in its project's editor (`/dock/project/<id>/editor/<type>/typeid/<type>-…`) or the
  // assets editor (`/dock/assets/editor/…`).
  const inEditor = where.includes('/assets/editor/') || /^\/dock\/project\/[^/]+\/editor\//.test(where);
  return inEditor && (where.includes(`typeid/${type}-`) || where.includes(`/${type}/`));
}

export function score(r: Row, url: URL, asked: boolean, log: LogRow | null, popup?: string): { verdict: Verdict; reason: string } {
  const where = url.pathname + url.search;
  const did = asked
    ? `asked the assistant (${log?.data?.reason ?? '?'} ${(log?.output?.confidence ?? 0).toFixed(2)})`
    : `opened ${popup ? `${popup} in a window` : where}`;
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
    if (!asked && landedLike(r.target, url, popup)) return { verdict: 1, reason: '' };
    const missing = log?.output?.route === 'agentic' && !(log?.input && r.target.startsWith('log:'));
    return { verdict: 2, reason: `${did}${missing ? ' — the thing may not exist on this instance, or search missed it' : ''}` };
  }
  const want = prefix(r.target);
  if (popup && want.startsWith('/win/') && popup === want) return { verdict: 1, reason: '' };
  if (want === '/dock/home' && url.pathname === '/') return { verdict: 1, reason: '' }; // Home's canonical address
  if (DEFAULT_TAB[url.pathname] && want.startsWith(DEFAULT_TAB[url.pathname])) return { verdict: 1, reason: '' };
  const works = where === want || where.startsWith(want) || url.pathname === want.split('?')[0] && !want.includes('?');
  if (works) return { verdict: 1, reason: '' };
  const needsContext = r.target.includes('<') ? ' — needs "this …" context the Home page does not give' : '';
  const sameView = !asked && url.pathname.split('/')[2] === want.split('/')[2];
  return { verdict: 2, reason: `${sameView ? 'right screen, other tab — ' : ''}${did}${needsContext}` };
}

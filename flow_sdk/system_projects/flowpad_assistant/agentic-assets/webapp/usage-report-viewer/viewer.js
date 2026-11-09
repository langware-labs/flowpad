// How a usage summary looks — the viewer for the `usage.summary` kind
// (flow_sdk/schema/data_spec/usage_report_spec.py UsageSummarySpec).
//
// Self-contained: everything comes in through `ctx` (the DOM helper `ctx.h`, the generic viewer
// `ctx.generic`), so this module imports nothing. Contract: ts_sdk/src/viewers/contract.ts.

export const contract = 1;

const money = (n) => `$${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tokens = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n || 0));
const span = (ms) => {
  const m = Math.floor((ms || 0) / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
const day = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '';
};

function tile(h, label, value) {
  return h('div', { class: 'ur-tile' }, h('div', { class: 'ur-tile-value' }, value), h('div', { class: 'ur-tile-label' }, label));
}

function table(h, title, rows, cols) {
  if (!rows?.length) return null;
  return h('section', { class: 'ur-section' },
    h('h4', {}, title),
    h('table', { class: 'ur-table' },
      h('tbody', {}, ...rows.map((r) => h('tr', {}, ...cols.map((c, i) => h('td', { class: i ? 'ur-num' : '' }, c(r))))))));
}

function sessions(h, list) {
  if (!list?.length) return null;
  const sorted = [...list].sort((a, b) => (b.cost_usd || 0) - (a.cost_usd || 0));
  return h('section', { class: 'ur-section', 'data-testid': 'usage-report-sessions' },
    h('h4', {}, `Sessions (${list.length})`),
    h('table', { class: 'ur-table' },
      h('thead', {}, h('tr', {}, ...['Session', 'Cost', 'Active', 'Prompts'].map((t, i) => h('th', { class: i ? 'ur-num' : '' }, t)))),
      h('tbody', {}, ...sorted.map((s) => h('tr', {},
        h('td', {}, h('a', { href: `/dock/lens/claude/transcript/${s.session_id}`, class: 'ur-link' }, s.title || s.project || s.session_id.slice(0, 8))),
        h('td', { class: 'ur-num' }, money(s.cost_usd)),
        h('td', { class: 'ur-num' }, span(s.duration_ms)),
        h('td', { class: 'ur-num' }, String(s.prompt_count || 0)))))));
}

const single = {
  async mount(el, req, ctx) {
    const { h } = ctx;
    const mode = req.mode || 'view';
    if (mode === 'edit' || mode === 'compare') return ctx.generic.single.mount(el, req, ctx);
    const v = req.value || {};
    el.replaceChildren();
    if (mode === 'line') {
      el.append(h('span', { class: 'ur-line' }, h('b', {}, day(v.period_start)), h('span', {}, `${money(v.total_cost_usd)} · ${v.session_count || 0} sessions`)));
      return {};
    }
    el.append(
      h('div', { class: 'ur-root', 'data-testid': 'usage-report-viewer' },
        h('header', { class: 'ur-hero' },
          h('div', { class: 'ur-title' }, `Usage — ${day(v.period_start)}`),
          h('div', { class: 'ur-tiles' },
            tile(h, 'cost', money(v.total_cost_usd)),
            tile(h, 'sessions', String(v.session_count || 0)),
            tile(h, 'active', span(v.total_duration_ms)),
            tile(h, 'prompts', String(v.prompt_count || 0)),
            tile(h, 'tokens', tokens(v.total_tokens)),
            tile(h, 'cache hits', `${((v.cache_hit_rate || 0) * 100).toFixed(1)}%`))),
        table(h, 'Models', v.models, [(r) => r.model, (r) => money(r.cost_usd)]),
        table(h, 'Skills', v.top_skills, [(r) => r.name, (r) => String(r.count)]),
        table(h, 'Agents', v.top_agents, [(r) => r.type, (r) => String(r.count)]),
        table(h, 'Tools', v.top_tools, [(r) => r.name, (r) => String(r.count)]),
        sessions(h, v.sessions)),
    );
    return {};
  },
};

const collection = {
  async mount(el, req, ctx) {
    const { h } = ctx;
    const items = req.items || [];
    const list = h('div', { class: 'ur-list' });
    items.forEach((v, i) => {
      list.append(h('div', { class: `ur-row${req.selected === i ? ' ur-on' : ''}`, onclick: () => req.on?.('select', i) },
        h('span', { class: 'ur-row-title' }, day(v?.period_start) || '—'),
        h('span', { class: 'ur-muted' }, `${money(v?.total_cost_usd)} · ${v?.session_count || 0} sessions`)));
    });
    if (!items.length) list.append(h('div', { class: 'ur-muted' }, 'No usage summaries.'));
    el.replaceChildren(list);
    const select = (index) => [...list.children].forEach((row, i) => row.classList.toggle('ur-on', i === index));
    return { select };
  },
};

export const viewers = { 'usage.summary': { single, collection } };

export const styles = `
.ur-root { display: flex; flex-direction: column; gap: 1rem; }
.ur-muted { color: hsl(var(--muted-foreground)); font-size: 12px; }
.ur-hero { padding: 1rem 1.15rem; border-radius: 14px; border: 1px solid hsl(var(--border)); background: hsl(var(--muted) / .35); }
.ur-title { font-size: 20px; font-weight: 650; letter-spacing: -.01em; margin-bottom: .7rem; }
.ur-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: .6rem; }
.ur-tile-value { font-size: 18px; font-weight: 650; font-variant-numeric: tabular-nums; }
.ur-tile-label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: hsl(var(--muted-foreground)); }
.ur-section > h4 { margin: 0 0 .4rem; font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: hsl(var(--muted-foreground)); }
.ur-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ur-table td, .ur-table th { padding: .3rem .5rem; border-bottom: 1px solid hsl(var(--border) / .6); text-align: left; }
.ur-table th { font-weight: 600; color: hsl(var(--muted-foreground)); font-size: 12px; }
.ur-num { text-align: right !important; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ur-link { color: hsl(var(--primary)); text-decoration: none; } .ur-link:hover { text-decoration: underline; }
.ur-line { display: inline-flex; gap: .5rem; align-items: center; }
.ur-list { display: flex; flex-direction: column; }
.ur-row { display: flex; gap: .6rem; align-items: center; padding: .45rem .6rem; border-radius: 8px; cursor: pointer; }
.ur-row:hover, .ur-row.ur-on { background: hsl(var(--accent)); }
.ur-row-title { flex: 1; min-width: 0; }
`;

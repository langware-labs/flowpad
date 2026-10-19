// How a diagnosis looks — the viewer for the `diagnosis` kind (flow_sdk/schema/data_spec/diagnose_spec.py).
//
// Self-contained: everything comes in through `ctx` (the DOM helper `ctx.h`, the generic viewer
// `ctx.generic`), so this module imports nothing. It shows the asker's machine, never the reader's:
// everything here travelled with the diagnosis. Contract: ts_sdk/src/viewers/contract.ts.

export const contract = 1;

const STATUS = {
  ok: ['All good', 'dg-good'],
  informational: ['Worth knowing', 'dg-info'],
  needs_action: ['Needs action', 'dg-bad'],
  fixed: ['Fixed', 'dg-good'],
  unrecognized: ['Unrecognized problem', 'dg-bad'],
  partial: ['Incomplete diagnosis', 'dg-warn'],
};
const SEVERITY = { error: 'dg-bad', warning: 'dg-warn', info: 'dg-info' };

const statusOf = (v) => STATUS[v?.status] || [v?.status || 'Diagnosis', 'dg-info'];
const when = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleString() : '';
};

function badge(h, v) {
  const [label, tone] = statusOf(v);
  return h('span', { class: `dg-badge ${tone}`, 'data-testid': 'diagnosis-status' }, label);
}

function prose(h, label, text) {
  if (!text) return null;
  return h('div', { class: 'dg-prose' }, h('div', { class: 'dg-label' }, label), h('div', { class: 'dg-text' }, text));
}

function findings(h, list) {
  if (!list?.length) return null;
  return h('section', { class: 'dg-section' },
    h('h4', {}, `Findings (${list.length})`),
    ...list.map((f) =>
      h('div', { class: `dg-finding ${SEVERITY[f.severity] || 'dg-info'}`, 'data-testid': 'diagnosis-finding' },
        h('div', { class: 'dg-finding-head' },
          h('span', { class: 'dg-finding-title' }, f.title || f.id),
          h('span', { class: 'dg-id', title: 'check id' }, f.id)),
        f.detail ? h('div', { class: 'dg-text' }, f.detail) : null,
        f.evidence ? h('div', { class: 'dg-mono' }, f.evidence) : null)));
}

function environment(h, env) {
  if (!env) return null;
  const rows = [
    ['Reported by', env.reported_by],
    ['When', when(env.occurred_at)],
    ['OS', env.os],
    ['Flowpad', env.app_version],
    ['Python', env.python],
    ['Instance', env.instance && `${env.instance}${env.backend_port ? ` · :${env.backend_port}` : ''}`],
    ['Hub', env.hub_url],
  ].filter(([, v]) => v);
  if (!rows.length) return null;
  return h('section', { class: 'dg-section' },
    h('h4', {}, 'Machine'),
    h('dl', { class: 'dg-env' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))])));
}

function problems(h, errors) {
  if (!errors?.length) return null;
  return h('section', { class: 'dg-section' },
    h('h4', {}, 'While diagnosing'),
    ...errors.map((e) => h('div', { class: 'dg-finding dg-warn', 'data-testid': 'diagnosis-error' }, h('div', { class: 'dg-text' }, e))));
}

function logs(h, tails) {
  if (!tails?.length) return null;
  return h('section', { class: 'dg-section' },
    h('h4', {}, 'Recent logs'),
    ...tails.map((t) =>
      h('details', { class: 'dg-log' },
        h('summary', {}, `${t.file.split(/[\\/]/).pop()} — last ${t.lines?.length ?? 0} lines`),
        h('pre', { class: 'dg-pre' }, (t.lines || []).join('\n')))));
}

const single = {
  async mount(el, req, ctx) {
    const { h } = ctx;
    const mode = req.mode || 'view';
    if (mode === 'edit' || mode === 'compare') return ctx.generic.single.mount(el, req, ctx);
    const v = req.value || {};
    el.replaceChildren();
    if (mode === 'line') {
      el.append(h('span', { class: 'dg-line' }, badge(h, v), h('span', {}, v.title || v.summary || '—')));
      return {};
    }
    const ran = [v.diagnose && `by ${v.diagnose}`, v.elapsed_ms ? `${(v.elapsed_ms / 1000).toFixed(1)}s` : null]
      .filter(Boolean).join(' · ');
    el.append(
      h('div', { class: 'dg-root', 'data-testid': 'diagnosis-viewer' },
        h('header', { class: 'dg-hero' },
          h('div', { class: 'dg-hero-top' }, badge(h, v), ran ? h('span', { class: 'dg-muted' }, ran) : null),
          h('div', { class: 'dg-title' }, v.title || 'Diagnosis'),
          v.summary ? h('div', { class: 'dg-summary' }, v.summary) : null),
        prose(h, 'What was reported', v.symptoms),
        prose(h, 'Cause', v.rca),
        prose(h, 'What to do', v.fix),
        findings(h, v.findings),
        problems(h, v.errors),
        environment(h, v.environment),
        logs(h, v.logs)),
    );
    return {};
  },
};

const collection = {
  async mount(el, req, ctx) {
    const { h } = ctx;
    const items = req.items || [];
    const list = h('div', { class: 'dg-list' });
    items.forEach((v, i) => {
      list.append(h('div', { class: `dg-row${req.selected === i ? ' dg-on' : ''}`, onclick: () => req.on?.('select', i) },
        badge(h, v),
        h('span', { class: 'dg-row-title' }, v?.title || v?.summary || '—'),
        h('span', { class: 'dg-muted' }, when(v?.environment?.occurred_at || v?.started_at))));
    });
    if (!items.length) list.append(h('div', { class: 'dg-muted' }, 'No diagnoses.'));
    el.replaceChildren(list);
    const select = (index) => [...list.children].forEach((row, i) => row.classList.toggle('dg-on', i === index));
    return { select };
  },
};

export const viewers = { diagnosis: { single, collection } };

// Problems are a tinted row with a coloured border; the text stays the foreground colour.
export const styles = `
.dg-root { display: flex; flex-direction: column; gap: 1rem; }
.dg-muted { color: hsl(var(--muted-foreground)); font-size: 12px; }
.dg-hero { padding: 1rem 1.15rem; border-radius: 14px; border: 1px solid hsl(var(--border)); background: hsl(var(--muted) / .35); }
.dg-hero-top { display: flex; gap: .6rem; align-items: center; margin-bottom: .35rem; }
.dg-title { font-size: 20px; font-weight: 650; letter-spacing: -.01em; }
.dg-summary { margin-top: .3rem; color: hsl(var(--foreground)); }
.dg-badge { font-size: 12px; font-weight: 600; padding: .05rem .6rem; border-radius: 999px; border: 1px solid; color: hsl(var(--foreground)); }
.dg-good { background: hsl(142 55% 42% / .12); border-color: hsl(142 55% 42% / .55); }
.dg-info { background: hsl(212 80% 55% / .10); border-color: hsl(212 80% 55% / .45); }
.dg-warn { background: hsl(38 92% 50% / .12); border-color: hsl(38 92% 50% / .6); }
.dg-bad { background: hsl(8 72% 52% / .10); border-color: hsl(8 72% 52% / .65); }
.dg-section > h4, .dg-label { margin: 0 0 .4rem; font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: hsl(var(--muted-foreground)); }
.dg-text { white-space: pre-wrap; }
.dg-finding { border: 1px solid; border-radius: 10px; padding: .55rem .75rem; margin-bottom: .45rem; }
.dg-finding-head { display: flex; justify-content: space-between; gap: .5rem; font-weight: 600; }
.dg-id { font-family: var(--font-mono); font-size: 11px; color: hsl(var(--muted-foreground)); }
.dg-mono { font-family: var(--font-mono); font-size: 11px; color: hsl(var(--muted-foreground)); margin-top: .25rem; word-break: break-all; }
.dg-env { display: grid; grid-template-columns: max-content 1fr; gap: .25rem .9rem; margin: 0; font-size: 13px; }
.dg-env dt { color: hsl(var(--muted-foreground)); } .dg-env dd { margin: 0; word-break: break-all; }
.dg-log { border: 1px solid hsl(var(--border)); border-radius: 10px; padding: .4rem .7rem; margin-bottom: .4rem; }
.dg-log summary { cursor: pointer; font-size: 13px; }
.dg-pre { font-family: var(--font-mono); font-size: 11px; max-height: 320px; overflow: auto; white-space: pre; margin: .4rem 0 0; }
.dg-line { display: inline-flex; gap: .5rem; align-items: center; }
.dg-list { display: flex; flex-direction: column; }
.dg-row { display: flex; gap: .6rem; align-items: center; padding: .45rem .6rem; border-radius: 8px; cursor: pointer; }
.dg-row:hover, .dg-row.dg-on { background: hsl(var(--accent)); }
.dg-row-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

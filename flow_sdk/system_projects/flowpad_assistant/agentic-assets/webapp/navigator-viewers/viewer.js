// How the smart navigator's data looks — viewers for its kinds (`views` in webapp.json).
//
// Self-contained: everything comes in through `ctx` (the DOM helper `ctx.h`, nested rendering
// `ctx.render` / `ctx.renderCollection`, the generic viewer `ctx.generic`), so this module imports
// nothing and every navigator.dataset — the SmartNavigator eval set, the SmartNavigationLog — is
// shown by it, wherever it appears: the dataset editor, the eval browser, inside an eval example.
// Contract: ts_sdk/src/viewers/contract.ts.

export const contract = 1;

const empty = (v) => v == null || v === '';
const golds = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// ── navigator.request — what was typed, and where ───────────────────────────

function whereCrumbs(h, here) {
  if (!here) return h('span', { class: 'nv-muted' }, 'somewhere unknown');
  const parts = [
    here.page && here.page !== 'desk' ? here.page : null,
    here.view,
    here.project?.title && `project ${here.project.title}`,
    here.process?.title && `session ${here.process.title}`,
    here.entity?.title && `open: ${here.entity.title}`,
  ].filter(Boolean);
  return h('span', { class: 'nv-crumbs', title: here.address || '' },
    ...parts.flatMap((p, i) => [i ? h('span', { class: 'nv-crumb-sep' }, '›') : null, h('span', { class: 'nv-crumb' }, p)]));
}

const request = {
  async mount(el, req, ctx) {
    const { h } = ctx;
    const v = req.value || {};
    const mode = req.mode || 'view';
    if (mode === 'edit' || mode === 'compare') return ctx.generic.single.mount(el, req, ctx);
    el.replaceChildren();
    if (mode === 'line') {
      el.append(h('span', {}, h('span', { class: 'nv-utter-line' }, v.utterance ?? '—'), v.here?.view ? h('span', { class: 'nv-muted' }, `  on ${v.here.view}`) : null));
      return {};
    }
    el.append(
      h('div', { class: 'nv-hero' },
        h('div', { class: 'nv-hero-label' }, 'Typed into the magic line'),
        h('div', { class: 'nv-utter' }, v.utterance ?? '—'),
        h('div', { class: 'nv-where' }, h('span', { class: 'nv-muted' }, 'while on'), whereCrumbs(h, v.here)),
        v.here?.address ? h('div', { class: 'nv-address' }, v.here.address) : null),
    );
    return {};
  },
};

// ── navigator.decision — where it goes, or the assistant ────────────────────

function decisionLine(d) {
  if (!d) return '—';
  if (d.route === 'agentic') return '↗ the assistant';
  const t = d.target ? `${d.target.kind} · ${d.target.value}` : 'nowhere';
  return d.verb === 'navigate' ? `${t} (take me there)` : t;
}

/** The parts a decision is judged on; a part the right answer leaves unset is free. */
const PARTS = [
  ['route', (d) => d?.route],
  ['target.kind', (d) => d?.target?.kind],
  ['target.value', (d) => d?.target?.value],
  ['verb', (d) => d?.verb],
];
function differing(gold, answered) {
  return new Set(PARTS.filter(([, get]) => !empty(get(gold)) && get(gold) !== get(answered)).map(([p]) => p));
}

function decisionCard(h, d, { title, diff = new Set(), tone = '' } = {}) {
  const bad = (part) => (diff.has(part) ? ' nv-bad' : '');
  if (!d) return h('div', { class: `nv-card ${tone}` }, title ? h('div', { class: 'nv-card-title' }, title) : null, h('div', { class: 'nv-muted' }, 'no answer'));
  const agentic = d.route === 'agentic';
  const conf = typeof d.confidence === 'number' ? d.confidence : null;
  return h('div', { class: `nv-card ${tone}` },
    title ? h('div', { class: 'nv-card-title' }, title) : null,
    h('div', { class: 'nv-route-line' },
      h('span', { class: `nv-route ${agentic ? 'nv-agentic' : 'nv-quick'}${bad('route')}`, title: agentic ? 'Starts an assistant turn' : 'Opens it straight away' },
        agentic ? 'hands to the assistant' : 'opens'),
      d.verb ? h('span', { class: `nv-verb${bad('verb')}`, title: 'navigate: the request asked to be taken there; show: just shown' }, d.verb) : null),
    agentic
      ? h('div', { class: 'nv-target nv-muted' }, 'no place — the assistant takes it from here')
      : h('div', { class: 'nv-target' },
          h('span', { class: `nv-kind${bad('target.kind')}` }, d.target?.kind ?? '?'),
          h('span', { class: `nv-value${bad('target.value')}` }, d.target?.value ?? '—')),
    conf != null
      ? h('div', { class: 'nv-conf', title: 'How sure it said it was. Being sure is not the same as being right.' },
          h('div', { class: 'nv-conf-track' }, h('div', { class: `nv-conf-fill${conf >= 0.85 ? ' nv-sure' : ''}`, style: `width:${Math.round(conf * 100)}%` })),
          h('span', {}, `${Math.round(conf * 100)}% sure`))
      : null);
}

const decision = {
  async mount(el, req, ctx) {
    const { h } = ctx;
    const mode = req.mode || 'view';
    // Labelling: the generic form, minus what only a producer has (its confidence).
    if (mode === 'edit') return ctx.generic.single.mount(el, { ...req, meta: { ...req.meta, omit: ['confidence'] } }, ctx);
    el.replaceChildren();
    if (mode === 'line') {
      const all = golds(req.value);
      el.append(h('span', { class: 'nv-line' }, all.length > 1 ? all.map(decisionLine).join('  |  ') : decisionLine(all[0] ?? req.value)));
      return {};
    }
    if (mode === 'view') {
      el.append(decisionCard(h, req.value));
      return {};
    }
    // compare: the right answer (several = any one counts) against what was answered.
    const answered = req.other;
    const all = golds(req.value);
    const closest = all.reduce((best, g) => (best == null || differing(g, answered).size < differing(best, answered).size ? g : best), null);
    const diff = closest ? differing(closest, answered) : new Set();
    const same = closest && diff.size === 0;
    el.append(
      h('div', { class: `nv-verdict ${same ? 'nv-same' : 'nv-diff'}` },
        same ? '✓ Went to the right place' : closest ? `✗ Differs in ${[...diff].join(', ')}` : 'No right answer recorded yet'),
      h('div', { class: 'nv-compare' },
        h('div', { class: 'nv-stack' }, ...(all.length ? all : [null]).map((g, i) =>
          decisionCard(h, g, { title: all.length > 1 ? `Right answer ${i + 1} of ${all.length}` : 'Right answer', tone: 'nv-gold' }))),
        h('div', { class: 'nv-arrow' }, 'vs'),
        decisionCard(h, answered, { title: 'What it answered', diff, tone: same ? 'nv-ok' : 'nv-miss' })),
    );
    return {};
  },
};

// ── navigator.candidate — what the search offered ───────────────────────────

const candidates = {
  async mount(el, req, ctx) {
    const { h } = ctx;
    el.replaceChildren();
    const items = req.items || [];
    if (!items.length) return (el.append(h('div', { class: 'nv-muted nv-small' }, 'The search offered nothing for this request.')), {});
    el.append(h('div', { class: 'nv-cands' }, ...items.map((c, i) =>
      h('div', { class: 'nv-cand', onclick: () => req.on?.('select', i), title: c.typeid || c.path || '' },
        h('span', { class: 'nv-type' }, c.type || '?'),
        h('span', { class: 'nv-cand-title' }, c.title || c.path || c.typeid || '—'),
        c.path && c.title ? h('span', { class: 'nv-cand-sub' }, c.path) : null))));
    return {};
  },
};

// ── navigator.dataset — one example as a story; the examples as a list ─────

const example = {
  async mount(el, req, ctx) {
    const { h } = ctx;
    const row = req.value || {};
    const mode = req.mode || 'view';
    el.replaceChildren();
    if (mode === 'line') return ctx.render(el, { kind: 'navigator.request', value: row.input, mode: 'line' });

    const asked = h('div');
    const answer = h('div');
    const offered = h('div');
    const cands = row.context?.candidates || [];
    const data = row.data || {};
    // Inside an eval (compare) the eval already shows where the example sits; alone, the row says it.
    const chips = mode === 'compare' ? [] : [row.kind && `role: ${row.kind}`, data.suite && `suite: ${data.suite}`, data.group, data.from && `from: ${data.from}`].filter(Boolean);
    el.append(h('div', { class: 'nv-example' },
      asked,
      h('section', { class: 'nv-section' },
        h('h4', {}, mode === 'compare' ? 'The right answer, against what it answered' : mode === 'edit' ? 'The right answer' : 'Where it should go'),
        answer),
      h('details', { class: 'nv-section nv-offered', open: cands.length > 0 && cands.length <= 6 },
        h('summary', {}, `What the search offered — ${cands.length}`), offered),
      chips.length ? h('div', { class: 'nv-chips' }, ...chips.map((c) => h('span', { class: 'nv-chip' }, c))) : null,
    ));
    /** The run's own answer, as a card — beside the form when labelling (what a reviewer labels
     *  against), under the right answer when just viewing. Inside an eval, the compare shows it. */
    const ran = h('div');
    const showRan = row.output != null && mode !== 'compare';
    if (showRan) {
      if (mode === 'edit') answer.before(h('div', { class: 'nv-ran' }, h('div', { class: 'nv-card-title' }, 'What the run answered'), ran));
      else answer.parentElement.after(h('section', { class: 'nv-section' }, h('h4', {}, 'What the run answered'), ran));
    }
    const many = Array.isArray(row.ground_truth);
    const [, , mounted] = await Promise.all([
      ctx.render(asked, { kind: 'navigator.request', value: row.input, mode: 'view' }),
      ctx.renderCollection(offered, { kind: 'navigator.candidate', items: cands }),
      mode === 'edit'
        ? ctx.render(answer, { kind: many ? ['navigator.decision'] : 'navigator.decision', value: row.ground_truth ?? null, mode: 'edit' })
        : mode === 'compare'
          ? ctx.render(answer, { kind: 'navigator.decision', value: row.ground_truth, mode: 'compare', other: req.other?.output })
          : ctx.render(answer, { kind: 'navigator.decision', value: golds(row.ground_truth)[0] ?? null, mode: 'view' }),
      showRan ? ctx.render(ran, { kind: 'navigator.decision', value: row.output, mode: 'view' }) : null,
    ]);
    return { read: mode === 'edit' ? mounted.read : undefined };
  },
};

const examples = {
  async mount(el, req, ctx) {
    const { h } = ctx;
    el.replaceChildren();
    const items = req.items || [];
    const list = h('div', { class: 'nv-list' });
    for (const [i, row] of items.entries()) {
      const d = row.data || {};
      const needs = row.output != null && row.ground_truth == null;
      const did = d.address ? d.address : d.prompt != null ? '↗ assistant' : row.output != null ? decisionLine(row.output) : null;
      list.append(h('div', { class: `nv-row${req.selected === i ? ' nv-on' : ''}`, onclick: () => req.on?.('select', i) },
        h('span', { class: `nv-dot${needs ? ' nv-needs' : row.ground_truth != null ? ' nv-done' : ''}`, title: needs ? 'needs a label' : row.ground_truth != null ? 'labelled' : 'not run' }),
        h('div', { class: 'nv-row-main' },
          h('div', { class: 'nv-row-ask' }, row.input?.utterance ?? '—', row.input?.here?.view ? h('span', { class: 'nv-muted' }, `  on ${row.input.here.view}`) : null),
          h('div', { class: 'nv-row-sub' },
            h('span', { class: 'nv-arrow-sm' }, '→'), h('span', {}, golds(row.ground_truth).map(decisionLine).join('  |  ') || 'no right answer yet'),
            did ? h('span', { class: 'nv-did' }, `did: ${did}`) : null)),
        h('span', { class: 'nv-role' }, row.kind || '')));
    }
    if (!items.length) list.append(h('div', { class: 'nv-muted' }, 'No examples.'));
    el.append(list);
    const select = (index) => {
      [...list.children].forEach((row, i) => row.classList.toggle('nv-on', i === index));
      list.querySelector('.nv-on')?.scrollIntoView?.({ block: 'nearest' });
    };
    select(req.selected);
    return { select };
  },
};

export const viewers = {
  'navigator.request': { single: request },
  'navigator.decision': { single: decision },
  'navigator.candidate': { collection: candidates },
  'navigator.dataset': { single: example, collection: examples },
};

export const styles = `
.nv-muted { color: hsl(var(--muted-foreground)); } .nv-small { font-size: 12px; }
.nv-hero { position: relative; padding: 1rem 1.15rem; border-radius: 14px; margin-bottom: 1rem;
  background: radial-gradient(120% 140% at 0% 0%, hsl(var(--primary) / .16), transparent 60%), hsl(var(--muted) / .35);
  border: 1px solid hsl(var(--primary) / .25); }
.nv-hero-label { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: hsl(var(--muted-foreground)); }
.nv-utter { font-size: 24px; font-weight: 650; letter-spacing: -.01em; margin: .15rem 0 .45rem; }
.nv-utter::before { content: '“'; color: hsl(var(--primary)); margin-right: .1rem; } .nv-utter::after { content: '”'; color: hsl(var(--primary)); margin-left: .1rem; }
.nv-where { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; font-size: 13px; }
.nv-crumbs { display: inline-flex; gap: .3rem; align-items: center; flex-wrap: wrap; }
.nv-crumb { padding: .05rem .55rem; border-radius: 999px; background: hsl(var(--background) / .8); border: 1px solid hsl(var(--border)); font-size: 12px; }
.nv-crumb-sep { color: hsl(var(--muted-foreground)); }
.nv-address { margin-top: .45rem; font-family: var(--font-mono); font-size: 11px; color: hsl(var(--muted-foreground)); }
.nv-utter-line { font-weight: 550; }
.nv-section { margin: 0 0 1rem; } .nv-section > h4, .nv-offered > summary { margin: 0 0 .45rem; font-size: 12px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: hsl(var(--muted-foreground)); cursor: default; }
.nv-offered > summary { cursor: pointer; }
.nv-card { border: 1px solid hsl(var(--border)); border-radius: 12px; padding: .7rem .85rem; background: hsl(var(--background)); min-width: 0; }
.nv-card.nv-gold { border-color: hsl(142 55% 42% / .55); background: linear-gradient(180deg, hsl(142 55% 42% / .07), transparent); }
.nv-card.nv-ok { border-color: hsl(142 55% 42% / .55); }
.nv-card.nv-miss { border-color: hsl(8 72% 52% / .65); background: linear-gradient(180deg, hsl(8 72% 52% / .07), transparent); }
.nv-card-title { font-size: 11px; letter-spacing: .05em; text-transform: uppercase; color: hsl(var(--muted-foreground)); margin-bottom: .4rem; }
.nv-route-line { display: flex; gap: .4rem; align-items: center; margin-bottom: .4rem; }
.nv-route { font-size: 12px; font-weight: 600; padding: .05rem .55rem; border-radius: 999px; }
.nv-quick { background: hsl(212 80% 55% / .16); color: hsl(212 85% 68%); } .nv-agentic { background: hsl(268 60% 60% / .18); color: hsl(268 70% 74%); }
.nv-verb { font-size: 12px; color: hsl(var(--muted-foreground)); border: 1px dashed hsl(var(--border)); border-radius: 999px; padding: 0 .5rem; }
.nv-target { display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
.nv-kind { font-size: 12px; padding: 0 .45rem; border-radius: 6px; background: hsl(var(--muted)); }
.nv-value { font-family: var(--font-mono); font-size: 15px; word-break: break-all; }
.nv-bad { outline: 2px solid hsl(8 72% 52%); outline-offset: 2px; border-radius: 6px; }
.nv-conf { display: flex; gap: .5rem; align-items: center; margin-top: .55rem; font-size: 12px; color: hsl(var(--muted-foreground)); }
.nv-conf-track { flex: 1; height: 6px; border-radius: 3px; background: hsl(var(--muted)); overflow: hidden; max-width: 160px; }
.nv-conf-fill { height: 100%; background: hsl(40 80% 50%); } .nv-conf-fill.nv-sure { background: hsl(212 80% 55%); }
.nv-verdict { font-weight: 600; margin-bottom: .55rem; } .nv-same { color: hsl(142 60% 48%); } .nv-diff { color: hsl(var(--foreground)); }
.nv-diff::first-letter { color: hsl(8 72% 58%); }
.nv-compare { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: .7rem; align-items: stretch; }
.nv-stack { display: grid; gap: .5rem; } .nv-arrow { align-self: center; font-size: 12px; color: hsl(var(--muted-foreground)); }
@media (max-width: 640px) { .nv-compare { grid-template-columns: 1fr; } .nv-arrow { justify-self: center; } }
.nv-cands { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: .45rem; }
.nv-cand { display: grid; gap: .1rem; padding: .45rem .6rem; border-radius: 10px; border: 1px solid hsl(var(--border)); background: hsl(var(--muted) / .25); min-width: 0; }
.nv-type { font-size: 11px; color: hsl(var(--primary)); } .nv-cand-title { font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nv-cand-sub { font-family: var(--font-mono); font-size: 11px; color: hsl(var(--muted-foreground)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nv-chips { display: flex; gap: .35rem; flex-wrap: wrap; } .nv-chip { font-size: 12px; padding: .05rem .5rem; border-radius: 6px; border: 1px solid hsl(var(--border)); color: hsl(var(--muted-foreground)); }
.nv-ran { margin-bottom: .7rem; }
.nv-line { font-family: var(--font-mono); font-size: 12px; }
.nv-list { display: grid; gap: .35rem; }
.nv-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: .65rem; align-items: center; padding: .55rem .75rem; border-radius: 10px; border: 1px solid hsl(var(--border)); cursor: pointer; transition: background .12s, border-color .12s; }
.nv-row:hover { background: hsl(var(--muted) / .4); } .nv-row.nv-on { border-color: hsl(var(--primary)); background: hsl(var(--primary) / .08); }
.nv-dot { width: 8px; height: 8px; border-radius: 50%; background: hsl(var(--muted-foreground) / .5); } .nv-dot.nv-done { background: hsl(142 60% 45%); } .nv-dot.nv-needs { background: hsl(40 80% 50%); }
.nv-row-ask { font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nv-row-sub { display: flex; gap: .4rem; align-items: baseline; font-family: var(--font-mono); font-size: 12px; color: hsl(var(--muted-foreground)); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.nv-did { margin-left: .6rem; opacity: .8; } .nv-arrow-sm { color: hsl(var(--primary)); }
.nv-role { font-size: 11px; color: hsl(var(--muted-foreground)); }
`;

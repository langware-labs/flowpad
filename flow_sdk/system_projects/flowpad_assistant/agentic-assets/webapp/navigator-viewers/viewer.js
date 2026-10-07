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
    // Where it was typed is the Flow context -- drawn by ITS viewer, the same one everywhere.
    const where = h('div', { class: 'nv-where-body' });
    el.append(
      h('div', { class: 'nv-hero' },
        h('div', { class: 'nv-hero-label' }, 'Typed into the magic line'),
        h('div', { class: 'nv-utter' }, v.utterance ?? '—'),
        h('div', { class: 'nv-where' }, h('span', { class: 'nv-muted' }, 'while on'), where)),
    );
    await ctx.render(where, { kind: 'navigation.here', value: v.here ?? null });
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
      h(c.typeid && ctx.navigate ? 'button' : 'div', {
        class: `nv-cand${c.typeid && ctx.navigate ? ' nv-cand-link' : ''}`,
        onclick: () => (c.typeid && ctx.navigate ? ctx.navigate(c.typeid) : req.on?.('select', i)),
        title: c.typeid ? `Open ${c.typeid}` : c.path || '',
      },
        h('span', { class: 'nv-type' }, c.type || '?'),
        h('span', { class: 'nv-cand-title' }, c.title || c.path || c.typeid || '—'),
        c.path && c.title ? h('span', { class: 'nv-cand-sub' }, c.path) : null))));
    return {};
  },
};

// ── navigator.run — how an answer was reached ─────────────────────────────

/** How it was decided when no model answered: [one line, in full]. */
const NO_MODEL = {
  rule: ['a rule matched — no model asked', 'Decided by a rule — the request named a screen outright, so no model was asked.'],
  empty: ['nothing typed', 'Nothing was typed.'],
  no_endpoint: ['no decision API', 'No decision API was reachable, so the request went to the assistant as typed.'],
};
const noModel = (reason, full) => (NO_MODEL[reason] ?? [`no model asked (${reason || 'unknown'})`, `No model was asked (${reason || 'unknown'}).`])[full ? 1 : 0];

/** One line: what the model picked, how sure, against the bar it had to clear. */
function runLine(run) {
  if (!run) return 'not recorded';
  const d = run.decision;
  if (!d) return noModel(run.reason, false);
  const target = d.response?.answers?.target;
  if (!target) return `the decision API failed (${run.reason || 'no answer'})`;
  const bar = d.act_at?.target;
  return `picked ${target.choice} · ${Math.round((target.confidence ?? 0) * 100)}% sure${bar ? ` (needs ${Math.round(bar * 100)}%)` : ''}`;
}

/** The decision itself is a generic `decision.run` -- its own viewer draws it. */
const run = {
  async mount(el, req, ctx) {
    const r = req.value;
    el.replaceChildren();
    if (!r) return (el.append(ctx.h('span', { class: 'nv-muted' }, 'not recorded')), {});
    if ((req.mode || 'view') === 'line') return (el.append(ctx.h('span', { class: 'nv-line' }, runLine(r))), {});
    if (!r.decision) return (el.append(ctx.h('div', { class: 'nv-no-model' }, noModel(r.reason, true))), {});
    return ctx.render(el, { kind: 'decision.run', value: r.decision });
  },
};

// ── navigator.dataset — one example as a story; the examples as a list ─────

/** One step of the story: numbered, openable on its own; its one-line summary is drawn the first
 *  time it is folded (`summarize`), since an open step shows the whole of it. */
function step(ctx, n, title, part, summarize) {
  const { h } = ctx;
  const summary = h('span', { class: 'nv-step-line' });
  const body = h('div', { class: 'nv-step-body' });
  const open = part && ctx.open
    ? h('button', { class: 'nv-open nv-step-open', title: 'Open this part on its own', onclick: (e) => (e.preventDefault(), ctx.open(part)) }, 'open ↗')
    : null;
  const el = h('details', { class: 'nv-step', open: true },
    h('summary', {}, h('span', { class: 'nv-step-n' }, String(n)), h('span', { class: 'nv-step-title' }, title), summary, open),
    body);
  if (summarize) el.addEventListener('toggle', () => !el.open && !summary.childNodes.length && summarize(summary));
  return { el, body };
}

/** How an example's answer was reached: an eval passes its trace (`{kind, value}`); a logged row keeps it. */
function traceOf(req, row) {
  const t = req.meta?.trace;
  if (t?.kind === 'navigator.run') return t.value;
  return row.data?.run ?? null;
}

const example = {
  async mount(el, req, ctx) {
    const { h } = ctx;
    const row = req.value || {};
    const mode = req.mode || 'view';
    el.replaceChildren();
    if (mode === 'line') return ctx.render(el, { kind: 'navigator.request', value: row.input, mode: 'line' });

    const cands = row.context?.candidates || [];
    const data = row.data || {};
    const trace = traceOf(req, row);
    // What the run decided: an eval's prediction (compare), the row's own output, else its right answer.
    const shown = (mode === 'compare' ? req.other?.output : row.output) ?? golds(row.ground_truth)[0] ?? null;
    const did = data.address ? `opened ${data.address}` : data.prompt != null ? 'handed to the assistant' : '';
    const line = (kind, value) => (into) => void ctx.render(into, { kind, value, mode: 'line' });

    const input = step(ctx, 1, 'Input', { kind: 'navigator.request', value: row.input, title: 'Input' }, line('navigator.request', row.input));
    const context = step(ctx, 2, 'Context', { kind: 'navigator.context', value: row.context ?? { candidates: [] }, title: 'Context' },
      (into) => (into.textContent = cands.length ? `${cands.length} search match${cands.length === 1 ? '' : 'es'}` : 'no search matches'));
    const model = step(ctx, 3, 'Model output', trace?.decision ? { kind: 'navigator.run', value: trace, title: 'Model output' } : null,
      (into) => (into.textContent = runLine(trace)));
    const selection = step(ctx, 4, mode === 'compare' ? 'Final selection, against the right answer' : mode === 'edit' ? 'Final selection — the right answer' : 'Final selection',
      null, line('navigator.decision', shown));
    // Inside an eval (compare) the eval already shows where the example sits; alone, the row says it.
    const chips = mode === 'compare' ? [] : [row.kind && `role: ${row.kind}`, data.suite && `suite: ${data.suite}`, data.group, data.from && `from: ${data.from}`].filter(Boolean);
    el.append(h('div', { class: 'nv-example' }, input.el, context.el, model.el, selection.el,
      chips.length ? h('div', { class: 'nv-chips' }, ...chips.map((c) => h('span', { class: 'nv-chip' }, c))) : null));
    if (!trace) model.body.append(h('div', { class: 'nv-muted nv-small' }, 'Not recorded for this example — run the eval again (or ask again with the log on) to see how it was decided.'));

    const answer = h('div');
    const renders = [
      ctx.render(input.body, { kind: 'navigator.request', value: row.input, mode: 'view' }),
      ctx.renderCollection(context.body, { kind: 'navigator.candidate', items: cands }),
      trace ? ctx.render(model.body, { kind: 'navigator.run', value: trace }) : null,
    ];
    if (mode === 'edit') {
      // Labelling: what the run answered beside the form (what a reviewer labels against).
      if (row.output != null) {
        const ran = h('div');
        selection.body.append(h('div', { class: 'nv-ran' }, h('div', { class: 'nv-card-title' }, 'What the run answered'), ran));
        renders.push(ctx.render(ran, { kind: 'navigator.decision', value: row.output, mode: 'view' }));
      }
      selection.body.append(answer);
      const many = Array.isArray(row.ground_truth);
      const mounted = await ctx.render(answer, { kind: many ? ['navigator.decision'] : 'navigator.decision', value: row.ground_truth ?? null, mode: 'edit' });
      await Promise.all(renders);
      return { read: mounted.read };
    }
    selection.body.append(answer);
    if (did) selection.body.append(h('div', { class: 'nv-did-line' }, `→ ${did}`));
    renders.push(mode === 'compare'
      ? ctx.render(answer, { kind: 'navigator.decision', value: row.ground_truth, mode: 'compare', other: req.other?.output })
      : ctx.render(answer, { kind: 'navigator.decision', value: shown, mode: 'view' }));
    await Promise.all(renders);
    return {};
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
  'navigator.run': { single: run },
};

export const styles = `
.nv-muted { color: hsl(var(--muted-foreground)); } .nv-small { font-size: 12px; }
.nv-hero { position: relative; padding: 1rem 1.15rem; border-radius: 14px; margin-bottom: 1rem;
  background: radial-gradient(120% 140% at 0% 0%, hsl(var(--primary) / .16), transparent 60%), hsl(var(--muted) / .35);
  border: 1px solid hsl(var(--primary) / .25); }
.nv-hero-label { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: hsl(var(--muted-foreground)); }
.nv-utter { font-size: 24px; font-weight: 650; letter-spacing: -.01em; margin: .15rem 0 .45rem; }
.nv-utter::before { content: '“'; color: hsl(var(--primary)); margin-right: .1rem; } .nv-utter::after { content: '”'; color: hsl(var(--primary)); margin-left: .1rem; }
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
.nv-step { border: 1px solid hsl(var(--border)); border-radius: 12px; margin-bottom: .7rem; background: hsl(var(--background)); }
.nv-step > summary { display: flex; gap: .55rem; align-items: center; padding: .55rem .8rem; cursor: pointer; list-style: none; }
.nv-step > summary::-webkit-details-marker { display: none; }
.nv-step[open] > summary { border-bottom: 1px solid hsl(var(--border)); }
.nv-step-n { display: inline-grid; place-items: center; width: 1.35rem; height: 1.35rem; border-radius: 50%; font-size: 11px; font-weight: 700; background: hsl(var(--primary) / .15); color: hsl(var(--primary)); flex: none; }
.nv-step-title { font-size: 12px; font-weight: 650; letter-spacing: .05em; text-transform: uppercase; flex: none; }
.nv-step-line { flex: 1; min-width: 0; font-size: 12px; color: hsl(var(--muted-foreground)); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.nv-step[open] .nv-step-line { visibility: hidden; }
.nv-step-body { padding: .75rem .9rem; }
.nv-step-body .nv-hero { margin-bottom: 0; }
.nv-open { font: inherit; font-size: 12px; padding: .1rem .55rem; border-radius: 999px; border: 1px solid hsl(var(--primary) / .45); background: hsl(var(--primary) / .06); color: hsl(var(--primary)); cursor: pointer; flex: none; }
.nv-open:hover { background: hsl(var(--primary) / .14); }
.nv-no-model { font-size: 13px; color: hsl(var(--muted-foreground)); }
.nv-did-line { margin-top: .5rem; font-size: 12px; color: hsl(var(--muted-foreground)); font-family: var(--font-mono); }
.nv-cand-link { font: inherit; text-align: left; color: inherit; cursor: pointer; } .nv-cand-link:hover { border-color: hsl(var(--primary) / .6); }
.nv-where { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; font-size: 13px; }
.nv-where-body { display: inline-block; }
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

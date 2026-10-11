/**
 * Viewers for Flowpad's own kinds, shipped by the `flow-viewers` asset:
 *
 * - **the Flow context** (`navigation.here`) — where the person was: page › screen › project ›
 *   session › what was open, its address, what was shown last. One structure, one viewer, wherever
 *   a context is shown.
 * - **`decision.run`** — one decision as it happened: per question the pick, the probability of every
 *   option (read by what the option means), the bar the pick had to clear, and what the call cost.
 *   What the model was asked opens on its own.
 * - **`decision.spec`** / **`decision.result`** — the request and the response, each on its own.
 * - **`navigation.map`** — every screen a request can be sent to; given by reference
 *   (`navigation.map.id.<uuid>`) it names the version, so a decision says which screens it offered.
 * - **`decision.wire`** — exactly what went over the wire: the endpoint, the body sent and the body
 *   that came back, verbatim — what to replay when a decision needs explaining.
 *
 * Generic: nothing here knows the navigator — what a decision means comes from the value itself
 * (`DecisionRun.act_at`, `state_kinds`, the options' own words). Entities are links (`ctx.navigate`),
 * parts open on their own (`ctx.open`) when the app offers it.
 */
import type { Answer, DecisionResult, DecisionRun, DecisionSpec, DecisionWire, Question } from '../decision/types';
import { copyToClipboard } from '../utils/utils';
import type { Shape, SingleViewer, ViewerContext } from './contract';
import { plain } from './generic';
import { parseValueRef } from './kinds';

type Ref = { typeid?: string; title?: string | null; path?: string | null } | null | undefined;
type Here = {
  page?: string | null;
  view?: string | null;
  pointer?: string | null;
  address?: string | null;
  project?: Ref;
  process?: Ref;
  entity?: Ref;
  last_shown?: { kind?: string; path?: string | null; typeid?: string | null } | null;
};

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

/** The trail of where someone was, broadest first. */
export function contextTrail(here: Here | null | undefined): { label: string; typeid?: string; title?: string }[] {
  if (!here) return [];
  const ref = (r: Ref, what: string) =>
    r?.typeid || r?.title ? { label: `${what} ${r?.title || r?.typeid}`, typeid: r?.typeid, title: r?.path || r?.typeid } : null;
  return [
    here.page && here.page !== 'desk' ? { label: here.page } : null,
    here.view ? { label: here.view, title: here.address || undefined } : null,
    ref(here.project, 'project'),
    ref(here.process, 'session'),
    ref(here.entity, 'open:'),
  ].filter(Boolean) as { label: string; typeid?: string; title?: string }[];
}

/** A choice's options by probability, highest first; the pick and the runner-up named. */
export function rankOptions(probabilities: Record<string, number> = {}, choice?: string) {
  const ranked = Object.entries(probabilities)
    .map(([key, p]) => ({ key, p: Number(p) || 0 }))
    .sort((a, b) => b.p - a.p || a.key.localeCompare(b.key));
  const pick = ranked.find((o) => o.key === choice) ?? ranked[0];
  const runnerUp = ranked.find((o) => o !== pick);
  return { ranked, pick, runnerUp, margin: pick && runnerUp ? pick.p - runnerUp.p : null };
}

/** A choice shows its options down to `NOTABLE` (at least `MIN_SHOWN`, at most `TOP_OPTIONS`); the
 *  rest fold into "n more, each under 1%". */
const TOP_OPTIONS = 10;
const MIN_SHOWN = 3;
const NOTABLE = 0.01;

/** Which ranked options show before the fold: the notable ones, bounded, and always the pick. */
export function visibleOptions<T extends { p: number }>(ranked: T[], pick?: T): T[] {
  const shown = ranked.filter((o, i) => i < MIN_SHOWN || (o.p >= NOTABLE && i < TOP_OPTIONS));
  if (pick && !shown.includes(pick)) shown.push(pick);
  return shown;
}

/** A probability as a percentage, no trailing zeros: 85%, 62.5%, 0.6%. */
const pct = (p: number) => `${Math.round(p * 1000) / 10}%`;

/** A viewer that only reads: editing or comparing its kind falls back to the generic viewer. */
const viewOnly = (mount: SingleViewer['mount']): SingleViewer => ({
  mount: (el, req, ctx) => (req.mode === 'edit' || req.mode === 'compare' ? ctx.generic.single.mount(el, req, ctx) : mount(el, req, ctx)),
});

/** An entity as a link when the host can open it (`ctx.navigate`), else as text. */
function entity(ctx: ViewerContext, typeid: string | null | undefined, label: string, cls = '', title?: string) {
  const link = typeid && ctx.navigate;
  return ctx.h(link ? 'button' : 'span', {
    class: `${cls}${link ? ' fv-link' : ''}`,
    title: link ? `Open ${typeid}` : title,
    onclick: link ? () => ctx.navigate!(typeid!) : undefined,
  }, label);
}

// ── the Flow context ──────────────────────────────────────────────────────────

const contextViewer = viewOnly((el, req, ctx) => {
  const { h } = ctx;
  const here = (req.value ?? null) as Here | null;
  el.replaceChildren();
  const trail = contextTrail(here);
  if (!trail.length && !here?.address) return (el.append(h('span', { class: 'dv-muted' }, 'nowhere known')), {});
  if (req.mode === 'line') return (el.append(h('span', {}, trail.map((c) => c.label).join(' › ') || here?.address || '')), {});
  const crumbs = h('span', { class: 'fv-crumbs' });
  trail.forEach((c, i) => {
    if (i) crumbs.append(h('span', { class: 'fv-sep' }, '›'));
    crumbs.append(entity(ctx, c.typeid, c.label, 'fv-crumb', c.title));
  });
  const shown = here?.last_shown;
  el.append(
    h('div', { class: 'fv-context' },
      crumbs,
      here?.address ? h('div', { class: 'fv-address', title: 'The address the person was on' }, here.address) : null,
      shown?.kind
        ? h('div', { class: 'fv-shown' }, h('span', { class: 'dv-muted' }, 'last shown: '), entity(ctx, shown.typeid, `${shown.kind} ${shown.path || shown.typeid || ''}`))
        : null),
  );
  return {};
});

// ── decision.spec — what the model was asked ─────────────────────────────────

/** The state, part by part: a part whose kind is known (`state_kinds`) is drawn by its viewer. */
function stateRows(ctx: ViewerContext, state: unknown, kinds: Record<string, unknown> = {}): HTMLElement {
  const { h } = ctx;
  if (state == null || typeof state !== 'object' || Array.isArray(state)) return h('pre', { class: 'dv-mono' }, plain(state));
  const box = h('div', { class: 'fv-kv' });
  for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
    const cell = h('div', { class: key === 'utterance' ? 'fv-strong' : 'dv-mono' });
    if (kinds[key]) void ctx.render(cell, { kind: kinds[key] as Shape, value: value ?? null });
    else if (Array.isArray(value) && !value.length) cell.append(h('span', { class: 'dv-muted' }, 'none'));
    else cell.append(plain(value));
    box.append(h('span', { class: 'fv-k' }, key), cell);
  }
  return box;
}

function questionCard(ctx: ViewerContext, name: string, q: Question): HTMLElement {
  const { h } = ctx;
  const options = q.type === 'choice' ? Object.entries(q.options) : [];
  const card = h('div', { class: 'fv-q' },
    h('div', { class: 'fv-q-head' }, h('b', {}, name), h('span', { class: 'dv-tag' }, q.type),
      options.length ? h('span', { class: 'dv-muted fv-small' }, `${options.length} options`) : null),
    q.instructions ? h('details', { class: 'fv-instr' }, h('summary', {}, 'instructions'), h('pre', { class: 'dv-mono' }, q.instructions)) : null);
  if (options.length) {
    const list = h('div', { class: 'fv-options' });
    for (const [key, meaning] of options)
      list.append(h('span', { class: 'fv-opt-key dv-mono' }, key), h('span', { class: 'fv-opt-meaning', title: meaning }, meaning));
    card.append(list);
  }
  if (q.type === 'score') card.append(h('div', { class: 'dv-chips' }, ...q.levels.map((l) => h('span', { class: 'dv-chip' }, l))));
  return card;
}

/** What was asked. `state_kinds` comes with the run it belongs to (`DecisionRun`), when opened from one. */
function mountSpec(el: HTMLElement, spec: DecisionSpec, ctx: ViewerContext, stateKinds?: Record<string, unknown>) {
  const { h } = ctx;
  el.append(h('div', { class: 'fv-h' }, 'The state it read'), stateRows(ctx, spec.state, stateKinds));
  for (const [name, q] of Object.entries(spec.questions ?? {})) el.append(h('div', { class: 'fv-h' }, `Question: ${name}`), questionCard(ctx, name, q));
  if (spec.model) el.append(h('div', { class: 'dv-muted fv-small' }, `model pinned: ${spec.model}`));
}

const decisionSpecViewer = viewOnly((el, req, ctx) => {
  const spec = (req.value ?? { questions: {} }) as DecisionSpec;
  el.replaceChildren();
  const names = Object.keys(spec.questions ?? {});
  if (req.mode === 'line') return (el.append(ctx.h('span', {}, `${names.length} question${names.length === 1 ? '' : 's'}: ${names.join(', ')}`)), {});
  mountSpec(el, spec, ctx, req.meta?.state_kinds as Record<string, unknown> | undefined);
  return {};
});

// ── what came back ────────────────────────────────────────────────────────────

/** An option's label: what it means when short enough to read in a row, else its key. */
const LABEL_MAX = 90;

/** One choice's options as bars, read by what each option means; the pick, the runner-up, the bar. */
function choiceBars(ctx: ViewerContext, answer: Answer, meanings: Record<string, string>, bar?: number): HTMLElement[] {
  const { h } = ctx;
  const label = (key: string) => (meanings[key] && meanings[key].length <= LABEL_MAX ? meanings[key] : key);
  const hover = (key: string) => (meanings[key] ? `${key} — ${meanings[key]}` : key);
  const choice = answer.type === 'choice' ? answer.choice : undefined;
  const probabilities = 'probabilities' in answer ? answer.probabilities : {};
  const { ranked, pick, runnerUp, margin } = rankOptions(probabilities, choice);
  const row = (o: { key: string; p: number }) => {
    const text = label(o.key);
    return h('div', { class: `fv-bar-row${o === pick ? ' fv-pick' : o === runnerUp ? ' fv-runner' : ''}`, title: hover(o.key) },
      h('span', { class: `fv-bar-key${text === o.key ? ' dv-mono' : ''}` }, text),
      h('span', { class: 'fv-bar-track' },
        h('span', { class: 'fv-bar-fill', style: `width:${Math.max(0.5, o.p * 100)}%` }),
        bar != null ? h('span', { class: 'fv-bar-threshold', style: `left:${bar * 100}%`, title: `needs ${pct(bar)} to act` }) : null),
      h('span', { class: 'fv-bar-p' }, pct(o.p)));
  };
  const shown = visibleOptions(ranked, pick);
  const box = h('div', { class: 'fv-bars' }, ...shown.map(row));
  const shownSet = new Set(shown);
  const rest = ranked.filter((o) => !shownSet.has(o));
  if (rest.length) {
    const under = rest.every((o) => o.p < NOTABLE);
    const more = h('button', { class: 'fv-more' }, `${rest.length} more option${rest.length === 1 ? '' : 's'}${under ? ', each under 1%' : ''}`);
    more.addEventListener('click', () => more.replaceWith(...rest.map(row)));
    box.append(more);
  }
  const picked = choice ?? pick?.key;
  const conf = 'confidence' in answer ? answer.confidence : (pick?.p ?? 0);
  const headline = h('div', { class: 'fv-headline' },
    h('span', { class: 'fv-pick-name', title: picked ? hover(picked) : undefined }, picked ? label(picked) : '—'),
    h('span', { class: `fv-conf${bar != null ? (conf >= bar ? ' fv-ok' : ' fv-low') : ''}` }, `${pct(conf)} sure`),
    bar != null ? h('span', { class: 'dv-muted fv-small' }, conf >= bar ? `clears the ${pct(bar)} bar` : `below the ${pct(bar)} bar`) : null,
    margin != null && runnerUp
      ? h('span', { class: 'dv-muted fv-small', title: hover(runnerUp.key) }, `ahead of ${label(runnerUp.key)} by ${pct(margin).replace('%', '')} pts`)
      : null);
  return [headline, ranked.length ? box : h('div', { class: 'dv-muted fv-small' }, 'no probabilities returned')];
}

/** Every answer, each read by its question (`questions`) against its bar (`act_at`). */
function mountAnswers(el: HTMLElement, result: DecisionResult, ctx: ViewerContext, questions: Record<string, Question> = {}, actAt: Record<string, number> = {}) {
  const { h } = ctx;
  for (const [name, answer] of Object.entries(result.answers ?? {})) {
    const section = h('div', { class: 'fv-answer' }, h('div', { class: 'fv-h' }, `Answer: ${name}`));
    const q = questions[name];
    if (answer.type === 'yes_no')
      section.append(h('div', { class: 'fv-headline' }, h('span', { class: 'fv-pick-name' }, `yes ${pct(answer.probability ?? 0)}`)));
    else section.append(...choiceBars(ctx, answer, q?.type === 'choice' ? q.options : {}, actAt[name]));
    el.append(section);
  }
  const usage = result.usage;
  el.append(h('div', { class: 'fv-cost dv-muted' },
    [result.model && `model ${result.model}`, usage && `${usage.input_tokens} in / ${usage.output_tokens} out tokens`,
      result.latency_ms != null && `${Math.round(result.latency_ms)} ms`, result.endpoint && `via ${result.endpoint}`].filter(Boolean).join(' · ')));
}

const answersLine = (result: DecisionResult) =>
  Object.entries(result.answers ?? {})
    .map(([n, a]) => `${n}: ${a.type === 'choice' ? a.choice : a.type === 'score' ? a.score.toFixed(2) : pct(a.probability)}`)
    .join(' · ');

const decisionResultViewer = viewOnly((el, req, ctx) => {
  const result = (req.value ?? { answers: {} }) as DecisionResult;
  el.replaceChildren();
  if (req.mode === 'line') return (el.append(ctx.h('span', { class: 'dv-mono' }, answersLine(result))), {});
  mountAnswers(el, result, ctx);
  return {};
});

/** One decision as it happened: the answers read by their questions against their bars, then what
 *  it was asked — on its own when the app can open parts, else folded in place (built on first open:
 *  a request can list every option there is). */
const decisionRunViewer = viewOnly((el, req, ctx) => {
  const { h } = ctx;
  const run = req.value as DecisionRun | null;
  el.replaceChildren();
  if (!run) return (el.append(h('span', { class: 'dv-muted' }, 'not recorded')), {});
  if (req.mode === 'line') return (el.append(h('span', { class: 'dv-mono' }, run.response ? answersLine(run.response) : 'no answer')), {});
  if (run.response) mountAnswers(el, run.response, ctx, run.request.questions, run.act_at);
  else el.append(h('div', { class: 'dv-muted' }, 'The decision API did not answer — this is what it was sent.'));
  const options = Object.values(run.request.questions ?? {}).reduce((n, q) => n + (q.type === 'choice' ? Object.keys(q.options).length : 0), 0);
  const links = h('div', { class: 'fv-links' });
  el.append(links);
  part(links, ctx, `What it was asked — ${options} options`,
    { kind: 'decision.spec', value: run.request, title: 'What the model was asked', meta: { state_kinds: run.state_kinds } },
    (body) => mountSpec(body, run.request, ctx, run.state_kinds));
  if (run.wire)
    part(links, ctx, `Exactly what was sent — ${run.wire.status || 'no'} ${run.wire.status === 200 ? 'OK' : 'reply'}`,
      { kind: 'decision.wire', value: run.wire, title: 'What was sent to the decision API' },
      (body) => mountWire(body, run.wire!, ctx));
  return {};
});

/** A part of a value: opened on its own when the app can open parts, else folded in place (built on
 *  first open: a request can list every option there is). */
function part(into: HTMLElement, ctx: ViewerContext, label: string, value: { kind: string; value: unknown; title: string; meta?: Record<string, unknown> }, inline: (body: HTMLElement) => void) {
  const { h } = ctx;
  if (ctx.open) {
    into.append(h('button', { class: 'fv-open', onclick: () => ctx.open!(value) }, label));
    return;
  }
  const body = h('div');
  const details = h('details', { class: 'fv-asked' }, h('summary', {}, label), body) as HTMLDetailsElement;
  details.addEventListener('toggle', () => details.open && !body.childElementCount && inline(body));
  into.append(details);
}

/** The call verbatim: where it went, then the two bodies as JSON, each copyable. */
function mountWire(el: HTMLElement, wire: DecisionWire, ctx: ViewerContext) {
  const { h } = ctx;
  const body = (title: string, value: unknown, testid: string) => {
    const text = JSON.stringify(value ?? null, null, 2);
    const copy = h('button', { class: 'fv-more', onclick: () => void copyToClipboard(text) }, 'Copy');
    return h('div', { class: 'fv-wire-part' },
      h('div', { class: 'fv-h' }, title, ' ', copy),
      h('pre', { class: 'fv-json dv-mono', 'data-testid': testid }, text));
  };
  el.append(
    h('div', { class: 'fv-headline dv-mono', 'data-testid': 'decision-wire-call' },
      `POST ${wire.endpoint || '?'} ${wire.path} → ${wire.status || 'no reply'}`),
    body('Request body (sent)', wire.request, 'decision-wire-request'),
    body('Response body (received)', wire.response, 'decision-wire-response'));
}

type Place = { view: string; label: string; aliases?: string[]; pointer?: string; subplaces?: { pointer: string; label: string }[] };

/** `navigation.map.id.7c1e2a3b-…` → `7c1e2a3b`: a version is told apart by its id's first block. */
export const shortVersion = (ref: unknown) => parseValueRef(ref)?.id.slice(0, 8) ?? '';

const navigationMapViewer = viewOnly((el, req, ctx) => {
  const { h } = ctx;
  const places = ((req.value as { places?: Place[] } | null)?.places ?? []) as Place[];
  const version = shortVersion(req.meta?.ref);
  const head = `${version ? `map ${version}` : 'map'} · ${places.length} screens`;
  el.replaceChildren();
  if (req.mode === 'line') return (el.append(h('span', { class: 'dv-mono', title: String(req.meta?.ref ?? '') }, head)), {});
  el.append(
    h('div', { class: 'fv-h', title: String(req.meta?.ref ?? '') }, head),
    h('table', { class: 'fv-places' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Screen'), h('th', {}, 'Also called'), h('th', {}, 'Address'), h('th', {}, 'Inside'))),
      h('tbody', {}, ...places.map((p) =>
        h('tr', {},
          h('td', {}, p.label),
          h('td', { class: 'dv-muted' }, (p.aliases ?? []).join(', ')),
          h('td', { class: 'dv-mono' }, p.view),
          h('td', { class: 'dv-muted', title: (p.subplaces ?? []).map((x) => x.label).join(', ') }, p.subplaces?.length ? String(p.subplaces.length) : ''))))));
  return {};
});

const decisionWireViewer = viewOnly((el, req, ctx) => {
  const wire = req.value as DecisionWire | null;
  el.replaceChildren();
  if (!wire) return (el.append(ctx.h('span', { class: 'dv-muted' }, 'not recorded')), {});
  if (req.mode === 'line') return (el.append(ctx.h('span', { class: 'dv-mono' }, `POST ${wire.path} → ${wire.status || 'no reply'}`)), {});
  mountWire(el, wire, ctx);
  return {};
});

export const flowViewers = {
  'navigation.here': { single: contextViewer },
  'decision.spec': { single: decisionSpecViewer },
  'decision.result': { single: decisionResultViewer },
  'decision.run': { single: decisionRunViewer },
  'decision.wire': { single: decisionWireViewer },
  'navigation.map': { single: navigationMapViewer },
};

export const FLOW_VIEWER_STYLES = `
.fv-places { border-collapse: collapse; font-size: 12px; width: 100%; }
.fv-places th { text-align: left; font-weight: 600; color: hsl(var(--muted-foreground)); border-bottom: 1px solid hsl(var(--border)); padding: .2rem .5rem .2rem 0; }
.fv-places td { padding: .15rem .5rem .15rem 0; border-bottom: 1px solid hsl(var(--border) / .4); vertical-align: top; }
.fv-json { margin: .2rem 0 .8rem; padding: .5rem .7rem; border-radius: 8px; background: hsl(var(--muted) / .45); font-size: 11.5px; line-height: 1.45; max-height: 28rem; overflow: auto; white-space: pre; }
.fv-crumbs { display: inline-flex; gap: .3rem; align-items: center; flex-wrap: wrap; }
.fv-crumb { padding: .05rem .55rem; border-radius: 999px; background: hsl(var(--muted) / .6); border: 1px solid transparent; font: inherit; font-size: 12px; color: hsl(var(--foreground)); }
button.fv-link { cursor: pointer; background: none; border: 0; padding: 0; color: hsl(var(--primary)); font: inherit; font-size: 12px; text-decoration: underline dotted; }
button.fv-crumb.fv-link { border: 1px solid hsl(var(--primary) / .5); text-decoration: none; padding: .05rem .55rem; background: hsl(var(--primary) / .06); }
button.fv-crumb.fv-link:hover { background: hsl(var(--primary) / .14); }
.fv-sep { color: hsl(var(--muted-foreground)); }
.fv-address { margin-top: .4rem; font-family: var(--font-mono); font-size: 11px; color: hsl(var(--muted-foreground)); }
.fv-shown { margin-top: .25rem; font-size: 12px; }
.fv-small { font-size: 12px; } .fv-strong { font-weight: 600; }
.fv-h { font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: hsl(var(--muted-foreground)); margin: .8rem 0 .35rem; }
.fv-kv { display: grid; grid-template-columns: max-content 1fr; gap: .25rem .8rem; align-items: start; }
.fv-k { font-size: 12px; color: hsl(var(--muted-foreground)); }
.fv-q { border: 1px solid hsl(var(--border)); border-radius: 10px; padding: .5rem .7rem; }
.fv-q-head { display: flex; gap: .5rem; align-items: center; }
.fv-instr summary, .fv-asked summary { cursor: pointer; font-size: 12px; color: hsl(var(--muted-foreground)); margin: .3rem 0; }
.fv-options { display: grid; grid-template-columns: max-content 1fr; gap: .15rem .8rem; margin-top: .4rem; max-height: 320px; overflow: auto; }
.fv-opt-meaning { font-size: 12px; color: hsl(var(--muted-foreground)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fv-headline { display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap; margin-bottom: .45rem; }
.fv-pick-name { font-size: 15px; font-weight: 600; }
.fv-conf { font-weight: 600; } .fv-conf.fv-ok { color: hsl(142 60% 48%); } .fv-conf.fv-low { color: hsl(40 85% 55%); }
.fv-bars { display: grid; gap: .2rem; }
.fv-bar-row { display: grid; grid-template-columns: minmax(10rem, 22rem) 1fr 3.4rem; gap: .5rem; align-items: center; font-size: 12px; padding: .05rem .3rem; border-radius: 6px; }
.fv-bar-row.fv-pick { background: hsl(var(--primary) / .1); } .fv-bar-row.fv-pick .fv-bar-key { font-weight: 700; }
.fv-bar-key { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fv-bar-track { position: relative; height: 8px; border-radius: 4px; background: hsl(var(--muted)); }
.fv-bar-fill { position: absolute; inset: 0 auto 0 0; border-radius: 4px; background: hsl(var(--muted-foreground) / .55); }
.fv-pick .fv-bar-fill { background: hsl(212 80% 55%); } .fv-runner .fv-bar-fill { background: hsl(40 80% 50%); }
.fv-bar-threshold { position: absolute; top: -3px; bottom: -3px; width: 2px; background: hsl(var(--foreground) / .7); }
.fv-bar-p { text-align: right; font-variant-numeric: tabular-nums; }
.fv-more { justify-self: start; font: inherit; font-size: 12px; background: none; border: 0; color: hsl(var(--primary)); cursor: pointer; padding: .2rem .3rem; }
.fv-answer + .fv-answer { margin-top: .6rem; }
.fv-cost { font-size: 12px; margin-top: .7rem; }
.fv-links { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: .8rem; }
.fv-open { font: inherit; font-size: 12px; padding: .1rem .55rem; border-radius: 999px; border: 1px solid hsl(var(--primary) / .45); background: hsl(var(--primary) / .06); color: hsl(var(--primary)); cursor: pointer; }
.fv-open:hover { background: hsl(var(--primary) / .14); }
`;

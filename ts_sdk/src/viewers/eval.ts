/**
 * Viewers for the eval contract (`eval.run`, `eval.example` — `flow_sdk/schema/data_spec/eval_spec.py`),
 * shipped by the `eval-viewers` asset. Generic over datasets: what an example ASKED and ANSWERED is
 * drawn by the dataset's own kinds (`meta.dataset_spec` → its slots), through `ctx.render` — so a
 * dataset with its own viewers shows its examples its own way inside every eval.
 */
import type { EvalExampleRow, EvalRun, Verdict } from '../evals/types';
import { VERDICTS } from '../evals/types';
import type { CollectionViewer, Shape, SingleViewer, ViewerContext } from './contract';
import { datasetSlots } from './generic';

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

export const isIssue = (e: EvalExampleRow) => e.verdict !== 'correct';

/** The issues grouped by cause — each `label=value` an issue carries is a group — biggest first. */
export function issueGroups(examples: EvalExampleRow[]): { cause: string; examples: EvalExampleRow[] }[] {
  const groups = new Map<string, EvalExampleRow[]>();
  for (const e of examples.filter(isIssue)) {
    for (const [key, value] of Object.entries(e.labels ?? {})) {
      const cause = `${key}=${value}`;
      groups.set(cause, [...(groups.get(cause) ?? []), e]);
    }
  }
  return [...groups.entries()]
    .map(([cause, list]) => ({ cause, examples: list }))
    .sort((a, b) => b.examples.length - a.examples.length || a.cause.localeCompare(b.cause));
}

/** `path=value` (a slice, a cause) as its two halves. */
export function splitPair(pair: string): [string, string] {
  const at = pair.indexOf('=');
  return at < 0 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)];
}

/** The examples a cause selects (all issues when there is no cause). */
export function byCause(examples: EvalExampleRow[], cause?: string): EvalExampleRow[] {
  const issues = examples.filter(isIssue);
  if (!cause) return issues;
  const [key, value] = splitPair(cause);
  return issues.filter((e) => e.labels?.[key] === value);
}

/** A count reads as a number, a ratio as a percentage. Which is which the backend SAYS
 *  (`count_metrics`, from the Python type) — JSON reads `1.0` and `1` the same. */
export function formatMetric(value: number | null | undefined, isCount = false): string {
  if (value == null) return '—';
  if (isCount) return String(Math.round(value));
  return value >= 0 && value <= 1 ? `${(value * 100).toFixed(1)}%` : value.toFixed(2);
}

/** What the eval contract's OWN columns mean, in plain words. A metric an eval defines is explained
 *  by that eval (`EvalSpec.explain`, arriving as `meta.explain`), never here. */
export const COLUMN_HELP: Record<string, string> = {
  run: 'One time the test was run. Its name is the date and time it started (UTC), then the name of the test. Click a row to open that run.',
  eval: 'Which test was run. A dataset can have several tests; each one checks the same examples its own way.',
  started: 'When the run began, in UTC time.',
  examples: 'How many examples (questions with a known right answer) were put to the system in this run.',
  n: 'How many examples fall in this row.',
  verdicts:
    'How the answers split. Green: right. Amber: it did not answer and passed the question on. Red: it answered, and the answer was wrong. Purple: the test itself broke on that example. Hover a colour for its count.',
  accuracy: 'Out of all the examples, the share answered right. Examples where the test broke are left out. Passing a question on counts as not right.',
  cause:
    'A tag the eval put on the examples that went wrong — what it answered, what kind of answer was right, and so on. One example can carry several tags, so it can appear in several rows. The biggest groups come first.',
  verdict: 'How this one example came out: correct, wrong, abstained (passed the question on) or error (the test broke).',
  asked: 'What was asked — the request exactly as it came in.',
  gold: 'The right answer, as recorded in the dataset. When several answers are acceptable they are separated by |.',
  'right answer': 'The right answer, as recorded in the dataset.',
  answered: 'What the system actually answered.',
  prediction: 'What the system actually answered.',
  score: 'The score the eval gave this answer. What it measures is the eval\'s own; compare it with the verdict.',
};

export const VERDICT_HELP: Record<Verdict, string> = {
  correct: 'Answered, and the answer matched the right one.',
  abstained: 'Did not answer itself; passed the question on.',
  wrong: 'Answered, and the answer did not match any right answer.',
  error: 'The test itself broke on this example, so it could not be judged.',
};

/** A column's tooltip: the eval's own words for its metric, else the contract's for its own column. */
export function columnHelp(key: string, explain: Record<string, string> = {}): string | undefined {
  if (explain[key]) return explain[key];
  if (COLUMN_HELP[key]) return COLUMN_HELP[key];
  if (key.includes('.')) return `The examples split by "${key}": each row is one value of it, with how that group did.`;
  return undefined;
}

// ── shared pieces ─────────────────────────────────────────────────────────────

type Meta = { count_metrics?: string[]; explain?: Record<string, string>; dataset_spec?: string; slice?: string; verdict?: string; cause?: string };

const metaOf = (m: unknown): Meta => (m ?? {}) as Meta;

/** A tooltip for `key` and the dotted underline that says one is there. */
const helpAttrs = (key: string, meta: Meta) => {
  const help = columnHelp(key, meta.explain);
  return { title: help, 'data-help': help ? true : undefined };
};

const th = (ctx: ViewerContext, key: string, meta: Meta, label = key) => ctx.h('th', helpAttrs(key, meta), label);

/** The verdicts as one bar; a bar you can pick from is the big one, a row's is the mini one. */
function verdictBar(ctx: ViewerContext, counts: Partial<Record<string, number | null>>, total: number, onPick?: (v: Verdict) => void) {
  const bar = ctx.h('div', { class: onPick ? 'ev-bar' : 'ev-bar ev-mini' });
  for (const v of VERDICTS) {
    const n = counts[v] ?? 0;
    if (!n) continue;
    const seg = ctx.h('div', { class: `ev-${v}`, title: `${v}: ${n} — ${VERDICT_HELP[v]}`, style: `width:${(100 * n) / Math.max(1, total)}%` });
    if (onPick) seg.addEventListener('click', (ev) => (ev.stopPropagation(), onPick(v)));
    bar.append(seg);
  }
  return bar;
}

const pill = (ctx: ViewerContext, v: Verdict, text: string = v) => ctx.h('span', { class: `ev-pill ev-${v}`, title: VERDICT_HELP[v] }, text);

/** The dataset's slot kinds — what an example asked (`input`) and answers (`output`). */
async function slotKinds(ctx: ViewerContext, datasetSpec?: string): Promise<{ input?: Shape; output?: Shape }> {
  const form = datasetSpec ? await ctx.kindForm(datasetSpec) : null;
  if (form?.subkind !== 'dataset') return {};
  const slots = datasetSlots(form);
  return { input: slots.find((s) => s.slot === 'input')?.shape, output: slots.find((s) => s.slot === 'output')?.shape };
}

/** A cell drawn by a kind's viewer in one line (or plain text when the dataset declares no kind). */
async function lineCell(ctx: ViewerContext, kind: Shape | undefined, value: unknown, cls = '') {
  const td = ctx.h('td', { class: cls });
  if (kind) await ctx.render(td, { kind, value, mode: 'line' });
  else td.textContent = value == null ? '—' : typeof value === 'string' ? value : JSON.stringify(value);
  return td;
}

/** An example as its dataset's row: the slots `ctx.render` draws by the dataset's kind. */
export function rowOf(e: EvalExampleRow): Record<string, unknown> {
  return {
    id: e.example_id,
    kind: e.row_kind,
    input: e.row_input,
    context: e.row_context,
    data: e.row_data,
    ground_truth: e.golds.length > 1 ? e.golds : e.golds[0],
  };
}

// ── eval.run ──────────────────────────────────────────────────────────────────

const runCollection: CollectionViewer = {
  async mount(el, req, ctx) {
    const { h } = ctx;
    const meta = metaOf(req.meta);
    const counts = new Set(meta.count_metrics ?? []);
    const runs = req.items as EvalRun[];
    el.replaceChildren();
    const keys = [...new Set(runs.flatMap((r) => Object.keys(r.metrics)))];
    const table = h('table', { class: 'dv-table' }, h('tr', {}, ...['run', 'eval', 'set', 'code', 'started', 'examples', 'verdicts', ...keys].map((k) => th(ctx, k, meta))));
    for (const [i, r] of runs.entries())
      table.append(
        h('tr', { class: `dv-pick${req.selected === i ? ' dv-on' : ''}`, onclick: () => req.on?.('select', i) },
          h('td', { class: 'dv-mono' }, r.run_id), h('td', {}, r.eval_name),
          // Which examples (dev `eval` / held-out `test`) and which code: runs compare only within one.
          h('td', { class: 'ev-small' }, (r.kinds ?? []).join(', ') || '—'),
          h('td', { class: 'dv-mono ev-small', title: Object.entries(r.versions ?? {}).map(([k, v]) => `${k} ${v}`).join('\n') },
            // A word (a code hash, a mode) inline; a value ref or a name with spaces in the tooltip.
            Object.values(r.versions ?? {}).filter((v) => !/\s|\.id\./.test(v)).join(' · ') || '—'),
          h('td', { class: 'ev-small' }, r.started_at.replace('T', ' ').slice(0, 19)),
          h('td', { class: 'ev-n' }, String(r.examples)), h('td', {}, verdictBar(ctx, r.counts, r.examples)),
          ...keys.map((k) => h('td', { class: 'ev-n' }, formatMetric(r.metrics[k], counts.has(k))))),
      );
    if (!runs.length) table.append(h('tr', {}, h('td', { colspan: 7 + keys.length, class: 'dv-muted' }, 'No eval has run on this dataset yet.')));
    el.append(h('div', { class: 'dv-scroll' }, table));
    return {};
  },
};

const runSingle: SingleViewer = {
  async mount(el, req, ctx) {
    const { h } = ctx;
    const r = req.value as EvalRun;
    const meta = metaOf(req.meta);
    const counts = new Set(meta.count_metrics ?? []);
    const card = (key: string, value: string) => {
      const { title, 'data-help': help } = helpAttrs(key, meta);
      return h('div', { class: 'ev-card', title }, h('b', {}, value), h('span', { 'data-help': help }, key.replace(/_/g, ' ')));
    };
    el.replaceChildren(
      h('div', { class: 'ev-small dv-muted' },
        `${r.dataset_spec} · eval ${r.eval_name} ${r.eval_digest} · ${Object.entries(r.versions).map(([k, v]) => `${k} ${v}`).join(' · ')}`),
      h('div', { class: 'ev-cards' }, card('examples', String(r.examples)), ...Object.entries(r.metrics).map(([k, v]) => card(k, formatMetric(v, counts.has(k))))),
      verdictBar(ctx, r.counts, r.examples, (v) => req.on?.('verdict', v)),
      h('div', { class: 'ev-legend' }, ...VERDICTS.map((v) =>
        h('span', { title: VERDICT_HELP[v], 'data-help': true, class: meta.verdict === v ? 'ev-picked' : '', onclick: () => req.on?.('verdict', v) },
          pill(ctx, v, String(r.counts[v] ?? 0)), ` ${v}`))),
    );
    const slices = Object.entries(r.slices ?? {});
    if (slices.length) el.append(h('h3', { class: 'ev-h' }, 'Slices — pick one to narrow everything below'));
    for (const [path, values] of slices) {
      const rows = Object.entries(values as Record<string, Record<string, number | null> & { examples: number }>);
      const keys = [...new Set(rows.flatMap(([, m]) => Object.keys(m)))].filter((k) => k !== 'examples' && k !== 'unlabelled' && !(VERDICTS as readonly string[]).includes(k));
      const table = h('table', { class: 'dv-table' }, h('tr', {}, th(ctx, path, meta), th(ctx, 'n', meta), th(ctx, 'verdicts', meta), ...keys.map((k) => th(ctx, k, meta))));
      for (const [value, m] of rows.sort((a, b) => b[1].examples - a[1].examples)) {
        const pair = `${path}=${value}`;
        table.append(
          h('tr', { class: `dv-pick${meta.slice === pair ? ' dv-on' : ''}`, onclick: () => req.on?.('slice', pair) },
            h('td', {}, value), h('td', { class: 'ev-n' }, String(m.examples)), h('td', {}, verdictBar(ctx, m, m.examples)),
            ...keys.map((k) => h('td', { class: 'ev-n' }, formatMetric(m[k], counts.has(k))))),
        );
      }
      el.append(h('div', { class: 'dv-scroll ev-gap' }, table));
    }
    return {};
  },
};

// ── eval.example ──────────────────────────────────────────────────────────────

const exampleCollection: CollectionViewer = {
  async mount(el, req, ctx) {
    const { h } = ctx;
    const meta = metaOf(req.meta);
    const examples = req.items as EvalExampleRow[];
    const { input, output } = await slotKinds(ctx, meta.dataset_spec);
    el.replaceChildren();

    const issues = examples.filter(isIssue);
    el.append(h('h3', { class: 'ev-h' }, `Issues — ${issues.length} of ${examples.length} in scope, grouped by cause`));
    const groups = h('table', { class: 'dv-table' }, h('tr', {}, th(ctx, 'cause', meta), th(ctx, 'examples', meta, 'examples'), th(ctx, 'verdicts', meta)));
    for (const g of issueGroups(examples)) {
      const counts: Record<string, number> = {};
      for (const e of g.examples) counts[e.verdict] = (counts[e.verdict] ?? 0) + 1;
      groups.append(
        h('tr', { class: `dv-pick${meta.cause === g.cause ? ' dv-on' : ''}`, onclick: () => req.on?.('cause', g.cause) },
          h('td', {}, h('span', { class: 'ev-chip' }, g.cause)), h('td', { class: 'ev-n' }, String(g.examples.length)), h('td', {}, verdictBar(ctx, counts, g.examples.length))),
      );
    }
    el.append(h('div', { class: 'dv-scroll ev-gap' }, groups));

    const list = byCause(examples, meta.cause);
    el.append(h('h3', { class: 'ev-h' }, meta.cause ? `Examples with ${meta.cause} — ${list.length}` : `All issues in scope — ${list.length}`));
    const table = h('table', { class: 'dv-table' }, h('tr', {}, ...['verdict', 'asked', 'right answer', 'answered', 'score'].map((k) => th(ctx, k, meta))));
    // Every row on screen at once; its cells — each drawn by the dataset's own viewers — side by side.
    el.append(h('div', { class: 'dv-scroll' }, table));
    await Promise.all(list.map(async (e) => {
      const tr = h('tr', { class: 'dv-pick', onclick: () => req.on?.('select', e.example_id) }, h('td', {}, pill(ctx, e.verdict)));
      table.append(tr);
      tr.append(...(await Promise.all([
        lineCell(ctx, input, e.row_input),
        lineCell(ctx, output, rowOf(e).ground_truth, 'ev-answer'),
        lineCell(ctx, output, e.prediction, 'ev-answer'),
      ])), h('td', { class: 'ev-n' }, e.score == null ? '—' : e.score.toFixed(2)));
    }));
    return {};
  },
};

const exampleSingle: SingleViewer = {
  async mount(el, req, ctx) {
    const { h } = ctx;
    const e = req.value as EvalExampleRow;
    const meta = metaOf(req.meta);
    const chips = [
      ...Object.entries(e.labels ?? {}).map(([k, v]) => h('span', { class: 'ev-chip', title: COLUMN_HELP.cause }, `${k}=${v}`)),
      ...Object.entries(e.slice ?? {}).filter(([k]) => !k.startsWith('labels.')).map(([k, v]) => h('span', { class: 'ev-chip ev-quiet' }, `${k.split('.').pop()}: ${v}`)),
    ];
    const body = h('div', { class: 'ev-example-body' });
    el.replaceChildren(
      h('div', { class: 'ev-verdict-line' }, pill(ctx, e.verdict),
        h('span', { class: 'ev-small dv-muted', title: COLUMN_HELP.score, 'data-help': true }, `score ${e.score == null ? '—' : e.score.toFixed(2)}`),
        h('span', { class: 'ev-small dv-muted' }, `${Math.round(e.latency_ms)} ms`)),
      h('div', { class: 'ev-chips' }, ...chips),
      ...(e.error ? [h('div', { class: 'ev-failed' }, e.error)] : []),
      // The eval's own word on this verdict, when the verdict alone would mislead.
      ...(e.note ? [h('div', { class: 'ev-note' }, e.note)] : []),
      body,
    );
    // The NESTING: the example itself is the dataset kind's — its own viewer draws it, the right
    // answer set against what this run answered.
    // How the inference reached its answer rides along (`trace`, as the run's `trace_kind`), so the
    // dataset's viewer can show the model's full output inside the story.
    if (meta.dataset_spec)
      await ctx.render(body, {
        kind: meta.dataset_spec,
        value: rowOf(e),
        mode: 'compare',
        other: { output: e.prediction },
        // How the answer was reached ({kind, value}) rides along, for the dataset's viewer to draw.
        meta: { ...req.meta, trace: e.trace ?? null },
        on: req.on,
      });
    return {};
  },
};

export const evalViewers = {
  'eval.run': { single: runSingle, collection: runCollection },
  'eval.example': { single: exampleSingle, collection: exampleCollection },
};

export const EVAL_VIEWER_STYLES = `
.ev-small { font-size: 12px; } .ev-n { font-variant-numeric: tabular-nums; }
.ev-h { font-size: 12px; font-weight: 600; margin: 1.4rem 0 .5rem; color: hsl(var(--muted-foreground)); text-transform: uppercase; letter-spacing: .05em; }
.ev-gap { margin-bottom: .75rem; }
.ev-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: .6rem; margin-top: .6rem; }
.ev-card { border: 1px solid hsl(var(--border)); border-radius: 12px; padding: .6rem .8rem; background: linear-gradient(180deg, hsl(var(--muted) / .35), transparent); }
.ev-card b { display: block; font-size: 22px; font-variant-numeric: tabular-nums; letter-spacing: -.01em; } .ev-card span { font-size: 12px; color: hsl(var(--muted-foreground)); }
.ev-bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: hsl(var(--muted)); margin: .8rem 0 .35rem; min-width: 80px; }
.ev-bar.ev-mini { height: 6px; margin: .35rem 0 0; } .ev-bar div { cursor: pointer; transition: filter .15s; } .ev-bar div:hover { filter: brightness(1.2); }
.ev-correct { background: hsl(142 60% 42%); } .ev-abstained { background: hsl(40 80% 50%); } .ev-wrong { background: hsl(8 72% 52%); } .ev-error { background: hsl(268 55% 58%); }
.ev-pill { display: inline-block; padding: 0 .55rem; border-radius: 999px; font-size: 12px; color: #fff; font-weight: 600; }
.ev-legend { display: flex; gap: 1rem; font-size: 12px; color: hsl(var(--muted-foreground)); flex-wrap: wrap; } .ev-legend > span { cursor: pointer; }
.ev-picked { color: hsl(var(--foreground)); font-weight: 600; }
.ev-chip { display: inline-block; padding: .05rem .5rem; border-radius: 6px; background: hsl(var(--muted)); font-size: 12px; margin: 1px 4px 1px 0; }
.ev-chip.ev-quiet { background: transparent; border: 1px solid hsl(var(--border)); color: hsl(var(--muted-foreground)); }
.ev-chips { margin: .45rem 0 .9rem; }
.ev-verdict-line { display: flex; gap: .7rem; align-items: center; }
.ev-note { margin-bottom: .8rem; padding: .45rem .7rem; border-radius: 8px; border: 1px solid hsl(40 80% 50% / .6); background: hsl(40 80% 50% / .08); font-size: 13px; }
.ev-failed { color: hsl(var(--foreground)); background: hsl(8 72% 52% / .08); border: 1px solid hsl(8 72% 52%); border-radius: 8px; padding: .5rem .75rem; margin-bottom: .8rem; }
`;

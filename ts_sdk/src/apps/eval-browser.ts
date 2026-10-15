/**
 * The Eval Browser, as an SDK-provided app: a dataset's eval runs, drilled down to one row.
 *
 * Generic — it reads only the eval contract (`EvalRun` / `RowEval`, `../evals/types`) through
 * the dataset's own actions (`evals`, `eval/<run>`, `run-eval`), so it browses ANY dataset's evals.
 * Mounted by a webapp asset that `edits: ["dataset"]`, opened with `?subject=dataset-<id>`.
 *
 * It draws nothing itself: every level is a DATA VIEWER (`../viewers`) — the runs (`eval.run`
 * collection), a run (`eval.run`), its issues (`eval.row` collection), one row
 * (`eval.row`) — and a row nests the DATASET's own viewer for its kind. The app owns only
 * the drill-down, kept in its URL (`?run=&slice=&verdict=&cause=&row=`, so back / forward walk
 * it), and the actions: run the eval, label a row, open it in the dataset editor.
 */
import type { EvalRow, EvalRun, Verdict } from '../evals/types';
import { h } from '../viewers/dom';
import { byCause, rowOf, splitPair } from '../viewers/eval';
import { appRoot, datasetViewerContext, hostDataset, mountLabel } from './dataset-app';
import { editorsFor } from './editors';
import { applyHostTheme, errorText, navigateHost } from './host';

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

/** Where the browser is: every field optional, all of it in the URL. */
export interface BrowserState {
  run?: string;
  /** `<path>=<value>` — a slice of the run (`data.group=D. Assets, by type`). */
  slice?: string;
  verdict?: Verdict;
  /** `<label>=<value>` — one cause among the issues (`did=/dock/tasks`). */
  cause?: string;
  row?: string;
}

const STATE_KEYS = ['run', 'slice', 'verdict', 'cause', 'row'] as const;

export function readState(search: string): BrowserState {
  const params = new URLSearchParams(search);
  const out: BrowserState = {};
  for (const key of STATE_KEYS) {
    const value = params.get(key);
    if (value) (out as Record<string, string>)[key] = value;
  }
  return out;
}

/** `search` with the state replaced (other params — `subject`, `theme` — kept). */
export function writeState(search: string, state: BrowserState): string {
  const params = new URLSearchParams(search);
  for (const key of STATE_KEYS) {
    const value = state[key];
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** The rows the state's slice and verdict select. */
export function inScope(rows: EvalRow[], state: BrowserState): EvalRow[] {
  const [path, value] = state.slice ? splitPair(state.slice) : ['', ''];
  return rows.filter((e) => (!state.slice || e.slice?.[path] === value) && (!state.verdict || e.verdict === state.verdict));
}

// ── the app ───────────────────────────────────────────────────────────────────

const STYLES = `
body { font: 14px/1.5 var(--font-sans); margin: 0; }
main { padding: 1rem 1.25rem 3rem; max-width: 1200px; }
header { display: flex; gap: .75rem; align-items: center; padding: .7rem 1.25rem; border-bottom: 1px solid hsl(var(--border)); flex-wrap: wrap; position: sticky; top: 0; background: hsl(var(--background)); z-index: 2; }
header h1 { font-size: 15px; margin: 0; }
.crumbs { display: flex; gap: .35rem; align-items: center; flex-wrap: wrap; font-size: 13px; }
.crumbs a { color: hsl(var(--primary)); cursor: pointer; text-decoration: none; } .crumbs .sep { color: hsl(var(--muted-foreground)); }
.muted { color: hsl(var(--muted-foreground)); } .small { font-size: 12px; }
button { font: inherit; padding: .25rem .7rem; border-radius: 6px; border: 1px solid hsl(var(--border)); background: hsl(var(--secondary)); color: inherit; cursor: pointer; }
button.primary { background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); border-color: transparent; }
button:disabled { opacity: .45; cursor: default; }
.bar { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin: .3rem 0 .9rem; }
.ok { color: hsl(142 70% 45%); }
.err { border: 1px solid hsl(8 72% 52%); border-radius: 8px; padding: .5rem .75rem; background: hsl(8 72% 52% / .08); }
`;

async function run(root: HTMLElement): Promise<void> {
  const dataset = await hostDataset();
  const subject = `dataset-${dataset.id}`;
  // Viewers nested in the dataset win for its kinds; every other kind resolves by the ontology.
  const ctx = datasetViewerContext(subject);
  const cache = new Map<string, { run: EvalRun; rows: EvalRow[]; count_metrics: string[]; explain: Record<string, string> }>();
  const loadRun = async (id: string) => {
    if (!cache.has(id)) cache.set(id, await dataset.evalRun(id));
    return cache.get(id)!;
  };

  const go = (state: BrowserState) => {
    history.pushState(null, '', `${location.pathname}${writeState(location.search, state)}`);
    void render();
  };
  // Back re-renders only when the drill-down moved (opening a part on its own keeps the URL).
  let shownSearch = '';
  window.addEventListener('popstate', () => location.search !== shownSearch && void render());

  const openDatasetEditor = async (rowId?: string) => {
    const editor = (await editorsFor(subject)).find((e: any) => e.name !== 'eval-browser');
    if (editor) navigateHost({ address: `/dock/app/${editor.typeid}?subject=${subject}${rowId ? `&row=${encodeURIComponent(rowId)}` : ''}` });
  };

  async function render(): Promise<void> {
    shownSearch = location.search;
    const state = readState(location.search);
    const crumbs = h('div', { class: 'crumbs' });
    const step = (label: string, to: BrowserState | null) => {
      if (crumbs.childElementCount) crumbs.append(h('span', { class: 'sep' }, '›'));
      crumbs.append(to ? h('a', { onclick: () => go(to) }, label) : h('span', {}, label));
    };
    const main = h('main');
    root.replaceChildren(
      h('header', {}, h('h1', {}, `${dataset.title || dataset.name} · evals`), crumbs, h('span', { style: 'flex:1' }),
        h('button', { onclick: () => void openDatasetEditor() }, 'Open dataset editor')),
      main,
    );
    try {
      step('Runs', state.run ? {} : null);
      if (!state.run) return await renderRuns(main);
      const loaded = await loadRun(state.run);
      const r = loaded.run;
      step(r.run_id, state.slice || state.verdict || state.cause || state.row ? { run: r.run_id } : null);
      if (state.slice) step(state.slice, state.cause || state.row ? { run: r.run_id, slice: state.slice } : null);
      if (state.verdict) step(state.verdict, null);
      if (state.cause) step(state.cause, state.row ? { ...state, row: undefined } : null);
      const meta = { count_metrics: loaded.count_metrics, explain: loaded.explain, dataset_spec: r.dataset_spec, versions: r.versions, ...state };
      if (state.row) {
        const e = loaded.rows.find((x) => x.row_id === state.row);
        step(e ? (e.title || state.row).slice(0, 48) : state.row, null);
        return await renderRow(main, loaded.rows, state, meta);
      }
      await renderRun(main, loaded.run, loaded.rows, state, meta);
    } catch (error: any) {
      main.append(h('div', { class: 'err' }, errorText(error)));
    }
  }

  async function renderRuns(main: HTMLElement): Promise<void> {
    const listing: { runs: EvalRun[]; count_metrics: string[]; explain: Record<string, Record<string, string>> } = await dataset.evalRuns();
    const status = h('span', { class: 'muted small' });
    const runNow = h('button', { class: 'primary' }, 'Run eval');
    runNow.addEventListener('click', async () => {
      runNow.setAttribute('disabled', 'true');
      status.textContent = 'running…';
      try {
        const fresh: EvalRun = await dataset.runEval({});
        go({ run: fresh.run_id });
      } catch (error) {
        status.textContent = errorText(error);
        runNow.removeAttribute('disabled');
      }
    });
    const box = h('div');
    main.append(h('div', { class: 'bar' }, runNow, status), box);
    // One metric name, one meaning: the first eval to explain it wins.
    const explain = Object.assign({}, ...Object.values(listing.explain ?? {}).reverse());
    await ctx.renderCollection(box, {
      kind: 'eval.run',
      items: listing.runs,
      meta: { count_metrics: listing.count_metrics, explain },
      on: (event, detail) => event === 'select' && go({ run: listing.runs[detail as number].run_id }),
    });
  }

  async function renderRun(main: HTMLElement, r: EvalRun, rows: EvalRow[], state: BrowserState, meta: Record<string, unknown>) {
    const summary = h('div');
    const issues = h('div');
    main.append(summary, issues);
    await ctx.render(summary, {
      kind: 'eval.run',
      value: r,
      meta,
      on: (event, detail) => {
        if (event === 'verdict') go({ run: r.run_id, slice: state.slice, verdict: detail === state.verdict ? undefined : (detail as Verdict) });
        if (event === 'slice') go({ run: r.run_id, slice: state.slice === detail ? undefined : (detail as string) });
      },
    });
    await ctx.renderCollection(issues, {
      kind: 'eval.row',
      items: inScope(rows, state),
      meta,
      on: (event, detail) => {
        if (event === 'cause') go({ ...state, cause: state.cause === detail ? undefined : (detail as string), row: undefined });
        if (event === 'select') go({ ...state, row: detail as string });
      },
    });
  }

  async function renderRow(main: HTMLElement, rows: EvalRow[], state: BrowserState, meta: Record<string, unknown>) {
    const list = byCause(inScope(rows, state), state.cause);
    const scopeList = list.some((e) => e.row_id === state.row) ? list : rows;
    const at = scopeList.findIndex((e) => e.row_id === state.row);
    const e = scopeList[at];
    if (!e) return void main.append(h('div', { class: 'err' }, `no row ${state.row} in this run`));
    const nav = (d: number) => scopeList[at + d] && go({ ...state, row: scopeList[at + d].row_id });
    const body = h('div');
    // How the answer was reached is fetched for this row only (the run's listing leaves it out).
    const trace = await dataset.evalTrace(String(state.run), e.row_id).catch(() => null);
    const showRow = () => ctx.render(body, { kind: 'eval.row', value: { ...e, trace }, meta });
    // Labelling is the dataset editor's own path (`mountLabel`): the row in edit mode, in place.
    const label = () =>
      mountLabel(body, {
        ctx,
        dataset,
        kind: String(meta.dataset_spec ?? ''),
        row: { ...rowOf(e), output: e.prediction },
        onCancel: () => void showRow(),
      });
    main.append(
      h('div', { class: 'bar' },
        h('button', { class: 'primary', onclick: () => void label() }, 'Label this row'),
        h('button', { onclick: () => void openDatasetEditor(e.row_id) }, 'Open in dataset editor'),
        h('span', { style: 'flex:1' }),
        h('span', { class: 'muted small' }, `${at + 1} of ${scopeList.length}`),
        h('button', { onclick: () => nav(-1), disabled: at <= 0 }, '‹ prev'),
        h('button', { onclick: () => nav(1), disabled: at >= scopeList.length - 1 }, 'next ›')),
      body,
    );
    await showRow();
  }

  await render();
}

/** Render the eval browser into `root` and connect it. Rejects with why it could not start. */
export async function mountEvalBrowser(into?: HTMLElement): Promise<void> {
  const root = appRoot(into);
  applyHostTheme();
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.append(style);
  try {
    await run(root);
  } catch (error: any) {
    root.replaceChildren(h('main', {}, h('div', { class: 'err' }, String(error?.message ?? error))));
    throw error;
  }
}

/**
 * The dataset editor, as an SDK-provided app: browse a dataset's examples and label them.
 *
 * Kind-driven, never dataset-specific: it draws nothing itself. The examples are the COLLECTION
 * viewer of the dataset's declared kind (`spec`, e.g. `navigator.dataset`), the chosen one its
 * SINGLE viewer in edit mode (`../viewers`) — a dataset whose kind has viewers of its own is shown
 * by them, any other by the generic viewer built from the kind definitions. The right answer the
 * viewer reads back is written through `annotate`.
 *
 * Mounted by a webapp asset in three lines — nested inside a dataset (it edits its parent), or
 * shipped on its own with `edits: ["dataset"]`, opened with `?subject=dataset-<id>` (and
 * `&example=<id>` to open one example).
 */
import type { Mounted } from '../viewers/contract';
import { h } from '../viewers/dom';
import { appRoot, datasetViewerContext, hostDataset, mountLabel } from './dataset-app';
import { editorsFor } from './editors';
import { appOption, applyHostTheme, navigateHost } from './host';

/** A row a run answered and nobody has labelled yet -- what a reviewer works through. */
export function needsLabel(row: { output?: unknown; ground_truth?: unknown }): boolean {
  return row.output != null && row.ground_truth == null;
}

const STYLES = `
body { font: 14px/1.55 var(--font-sans); margin: 0; }
header { display: flex; gap: .75rem; align-items: center; padding: .75rem 1rem; border-bottom: 1px solid hsl(var(--border)); position: sticky; top: 0; background: hsl(var(--background)); z-index: 2; flex-wrap: wrap; }
header h1 { font-size: 15px; margin: 0; }
.muted { color: hsl(var(--muted-foreground)); } .small { font-size: 12px; }
.mono { font-family: var(--font-mono); font-size: 12px; }
.err { color: hsl(var(--foreground)); } .ok { color: hsl(142 70% 45%); }
button { font: inherit; padding: .2rem .6rem; border-radius: 6px; border: 1px solid hsl(var(--border)); background: hsl(var(--secondary)); color: inherit; cursor: pointer; }
button.primary { background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); border-color: transparent; }
select { font: inherit; padding: .2rem .4rem; border-radius: 6px; border: 1px solid hsl(var(--border)); background: hsl(var(--background)); color: inherit; }
.split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 44%); gap: 1rem; padding: 1rem; align-items: start; }
.split.closed { grid-template-columns: minmax(0, 1fr); }
.detail { position: sticky; top: 4.2rem; border: 1px solid hsl(var(--border)); border-radius: 12px; padding: .9rem 1rem; max-height: calc(100vh - 6rem); overflow: auto; }
.bar { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin-top: .8rem; }
@media (max-width: 860px) { .split { grid-template-columns: minmax(0, 1fr); } .detail { position: static; max-height: none; } }
`;

/** Render the dataset editor into `root` and connect it. Rejects with why it could not start. */
export async function mountDatasetEditor(into?: HTMLElement): Promise<void> {
  const root = appRoot(into);
  applyHostTheme();
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.append(style);
  const status = h('span', { class: 'small', 'data-testid': 'dataset-editor-status' });
  try {
    await run(root, status);
  } catch (error: any) {
    status.textContent = String(error?.message ?? error);
    status.className = 'small err';
    if (!status.isConnected) root.replaceChildren(status);
    throw error;
  }
}

async function run(root: HTMLElement, status: HTMLElement): Promise<void> {
  // Nested: the dataset containing this app; else `?subject=` (resolveAppHost reads both).
  const dataset = await hostDataset();
  const subject = `dataset-${dataset.id}`;
  const kind = typeof dataset.spec === 'string' ? dataset.spec : '';
  const ctx = datasetViewerContext(subject);

  const { rows }: { rows: any[] } = await dataset.rows(); // every example with its values, in one request
  const counts = h('span', { class: 'muted small', 'data-testid': 'dataset-editor-counts' });
  const showCounts = () =>
    (counts.textContent =
      `${rows.length} examples · ${rows.filter((r) => r.ground_truth != null).length} labelled · ` +
      `${rows.filter(needsLabel).length} need a label`);
  showCounts();
  const filter = h('select', { 'data-testid': 'dataset-editor-filter' },
    ...[['', 'all'], ['needs-label', 'needs label'], ['train', 'train'], ['eval', 'eval'], ['test', 'test']].map(([v, t]) => h('option', { value: v }, t))) as HTMLSelectElement;
  const list = h('div', { 'data-testid': 'dataset-editor-rows' });
  const detail = h('div', { class: 'detail', 'data-testid': 'dataset-editor-form' });
  const split = h('div', { class: 'split closed' }, list, detail);
  detail.hidden = true;
  root.replaceChildren(
    h('header', {},
      h('h1', { 'data-testid': 'dataset-editor-title' }, dataset.title || dataset.name),
      h('span', { class: 'mono muted', 'data-testid': 'dataset-editor-kind' }, kind),
      counts, h('span', { style: 'flex:1' }), filter,
      h('button', { 'data-testid': 'dataset-editor-evals', onclick: () => void openEvals() }, 'Evals'),
      h('button', { 'data-testid': 'dataset-editor-validate', onclick: () => void validate() }, 'Validate'),
      status),
    split,
  );

  const shown = () => {
    const role = filter.value;
    return rows.filter((r) => (role === 'needs-label' ? needsLabel(r) : !role || r.kind === role));
  };
  let items: any[] = [];
  let listed: Mounted = {};
  /** Bumped by each list render, so an older one still drawing is dropped rather than shown. */
  let drawing = 0;
  const selectedAt = () => {
    const at = items.findIndex((r) => r.id === appOption('example'));
    return at < 0 ? undefined : at;
  };

  async function renderList() {
    const mine = ++drawing;
    items = shown();
    const target = h('div');
    const mounted = await ctx.renderCollection(target, {
      kind,
      items,
      selected: selectedAt(),
      on: (event, index) => event === 'select' && select(items[index as number]?.id),
    });
    if (mine !== drawing) return;
    listed = mounted;
    list.replaceChildren(target);
  }

  /** The chosen example is in the URL (`?example=`), so back / forward and a deep link reach it.
   *  Choosing one moves the list's highlight (no redraw) and opens it beside the list. */
  function select(id: string | undefined) {
    const params = new URLSearchParams(location.search);
    if (id) params.set('example', id);
    else params.delete('example');
    history.pushState(null, '', `${location.pathname}?${params}`);
    shownExample = appOption('example');
    showSelected();
  }

  function showSelected() {
    listed.select?.(selectedAt());
    void renderDetail();
  }

  async function renderDetail() {
    const row = rows.find((r) => r.id === appOption('example'));
    split.classList.toggle('closed', !row);
    detail.hidden = !row;
    if (!row) return;
    const body = h('div');
    detail.replaceChildren(
      h('div', { style: 'display:flex;align-items:center;gap:.5rem;margin-bottom:.6rem' },
        h('b', { class: 'small' }, `Example ${rows.indexOf(row) + 1}`), h('span', { class: 'muted small mono' }, row.kind),
        h('span', { style: 'flex:1' }), h('button', { onclick: () => select(undefined) }, 'Close')),
      body,
    );
    await mountLabel(body, {
      ctx,
      dataset,
      kind,
      row,
      onSaved: (value) => {
        row.ground_truth = value;
        showCounts();
        void renderList();
      },
    });
  }

  // The eval browser is another app on the same dataset: the HOST opens it (URL-first).
  async function openEvals() {
    const browser = (await editorsFor(subject)).find((e) => e.name === 'eval-browser');
    if (browser) navigateHost({ address: `/dock/app/${browser.typeid}?subject=${subject}` });
  }

  async function validate() {
    const out = await dataset.validate();
    status.textContent = out.problems.length ? `${out.problems.length} rows do not fit` : `all ${out.checked} rows fit`;
    status.className = `small ${out.problems.length ? 'err' : 'ok'}`;
  }

  filter.addEventListener('change', () => void renderList());
  // Back moves the chosen example only when it changed (opening a part on its own keeps the URL).
  let shownExample = appOption('example');
  window.addEventListener('popstate', () => {
    if (appOption('example') === shownExample) return;
    shownExample = appOption('example');
    showSelected();
  });
  await Promise.all([renderList(), renderDetail()]);
  status.textContent = 'Live';
  status.className = 'small ok';
}

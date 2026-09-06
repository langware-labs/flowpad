/**
 * The source editor, as an SDK-provided app.
 *
 * A data-source definition ships this as a webapp asset nested inside itself
 * (`<definition>/agentic-assets/webapp/editor/`), so the definition's editor is
 * an ordinary child asset: discovered by the indexer, addressed at
 * `/dock/app/micro_app-<id>`, served by `MicroApp.view`, and shown in the
 * address bar under its parent.
 *
 * The markup, the styles and the behaviour all live here so that each
 * definition's app is three lines — and so that improving the editor is one
 * edit rather than nine. A definition that wants something else replaces its
 * own `app.js`; nothing here is load-bearing for the mechanism.
 *
 * It learns everything from the page: the subject is the app's PARENT asset
 * (see `resolveAppHost`), and no backend URL is written anywhere in this file.
 */
import { dataManager } from '../APIEntity';
import { QueryRequest } from '../FlowSync/query';
import { TypeId } from '../models/TypeId';
import { DATASET_FIELD_KINDS, Dataset, coerceToKind } from '../entities/dataset';
import { dataContext } from '../FlowSync/context';
import { initSdk } from '../main';
import { appOption, applyHostTheme, resolveAppHost } from './host';

/** The kind options a person picks from: the SDK's declared kinds plus the
 *  one-element list form. `value` is what the shape carries, so nothing here
 *  parses JSON out of a `<select>`. */
const KIND_OPTIONS: { label: string; value: unknown }[] = [
  ...DATASET_FIELD_KINDS.map((k: string) => ({ label: k, value: k as unknown })),
  { label: 'list of string', value: ['string'] },
];

const STYLES = `
/* Palette, font stack and dark theme come from /sdk/flowpad.css, linked by the
   page — an editor embedded in Flowpad should look like Flowpad, so colour is
   not a choice made here. What IS decided here: the two-pane split (what this
   source IS, beside what came IN), mono as the utility face for machine values,
   and the state rail on each item — the one place boldness is spent. */
@layer base, panes, controls, items;

@layer base {
  body { font: 14px/1.55 var(--font-sans); }
  h2 {
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: hsl(var(--muted-foreground));
    margin: 0 0 0.75rem;
  }
  .muted { color: hsl(var(--muted-foreground)); }
  .small { font-size: 12px; }
  .err { color: hsl(var(--destructive)); }
  /* Machine values — ids, timestamps, the shape. Marking them apart from prose
     is the one typographic idea this tool needs. */
  .mono { font-family: var(--font-mono); font-size: 12px; }
}

@layer panes {
  .bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1.25rem;
    border-block-end: 1px solid hsl(var(--border));
    background: hsl(var(--card));
  }
  .bar strong { font-size: 0.9375rem; }
  .status {
    margin-inline-start: auto;
    font-size: 12px;
    color: hsl(var(--muted-foreground));
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .status::before {
    content: '';
    inline-size: 6px;
    block-size: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .status.ok { color: hsl(var(--brand)); }
  .status.err { color: hsl(var(--destructive)); }

  main {
    display: grid;
    grid-template-columns: minmax(300px, 26rem) 1fr;
    align-items: start;
    gap: 1.5rem;
    padding: 1.25rem;
  }
  @media (width < 60rem) { main { grid-template-columns: 1fr; } }
  .pane { min-width: 0; }
  .pane + .pane { border-inline-start: 1px solid hsl(var(--border)); padding-inline-start: 1.5rem; }
  @media (width < 60rem) {
    .pane + .pane { border-inline-start: 0; padding-inline-start: 0; border-block-start: 1px solid hsl(var(--border)); padding-block-start: 1.25rem; }
  }
  .group + .group { margin-block-start: 1.75rem; }
}

@layer controls {
  .row { display: grid; gap: 0.3rem; margin-block-end: 0.75rem; }
  .row > span { font-weight: 500; font-size: 13px; }
  .row small { color: hsl(var(--muted-foreground)); font-size: 12px; }

  input, select, textarea {
    font: inherit;
    padding: 0.4rem 0.55rem;
    inline-size: 100%;
    color: hsl(var(--foreground));
    background: hsl(var(--background));
    border: 1px solid hsl(var(--input));
    border-radius: var(--radius-sm);
  }
  textarea { resize: vertical; }
  input::placeholder, textarea::placeholder { color: hsl(var(--muted-foreground)); }

  button {
    font: inherit;
    font-weight: 500;
    padding: 0.4rem 0.75rem;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    background: hsl(var(--primary));
    color: hsl(var(--primary-foreground));
    cursor: pointer;
    &:hover { background: hsl(var(--primary) / 0.9); }
    &:disabled { opacity: 0.5; cursor: default; }
  }
  /* Secondary, not invisible. Promote is the frequent, low-cost step, so it must
     read as a button at a glance — transparent on a near-black canvas leaves only
     a 1px border, which is indistinguishable from the row separators around it. */
  button.ghost {
    background: hsl(var(--secondary));
    color: hsl(var(--secondary-foreground));
    border-color: hsl(var(--border));
    &:hover { background: hsl(var(--accent)); }
  }
  .actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  .shape-row { display: grid; grid-template-columns: 1fr 8rem 2rem; gap: 0.4rem; margin-block-end: 0.4rem; }
  .shape-row .ghost { padding-inline: 0; }
}

@layer items {
  .items { list-style: none; margin: 0; padding: 0; }

  /* The signature: a rail that tracks each item through the pipeline —
     untouched, promoted to an example, then labelled. The state string is
     already on the node for rendering, so the progression costs no extra JS and
     the list is readable at a glance instead of one row at a time. */
  .items li {
    padding: 0.6rem 0 0.6rem 0.85rem;
    border-block-end: 1px solid hsl(var(--border));
    border-inline-start: 2px solid transparent;
    &[data-state='promote'] { border-inline-start-color: hsl(var(--border)); }
    &[data-state^='label:'] { border-inline-start-color: hsl(var(--muted-foreground) / 0.5); }
    &[data-state$=':true'] { border-inline-start-color: hsl(var(--brand)); }
  }
  .item-title { font-weight: 500; text-wrap: pretty; }
  .items li small {
    display: block;
    font-family: var(--font-mono);
    font-size: 11px;
    color: hsl(var(--muted-foreground));
  }
  .tag {
    font-size: 11px;
    font-weight: 500;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: hsl(var(--secondary));
    color: hsl(var(--secondary-foreground));
  }
  li[data-state$=':true'] .tag { background: hsl(var(--brand)); color: hsl(var(--brand-foreground)); }

  .item-actions { display: flex; gap: 0.5rem; align-items: center; margin-block-start: 0.5rem; }
  .label { margin-block-start: 0.6rem; display: grid; gap: 0.35rem; }
  .label .field {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.6rem;
    align-items: center;
    max-inline-size: 34rem;
  }
  .label .field span { font-size: 12px; color: hsl(var(--muted-foreground)); }
}
`;

const MARKUP = `
<header class="bar">
  <strong id="title">Source editor</strong>
  <span id="status" class="status">Connecting…</span>
</header>
<main id="main" hidden>
  <section class="pane" aria-labelledby="config-heading">
    <div class="group">
      <h2 id="config-heading">Connection</h2>
      <label class="row">
        <span>Source</span>
        <select id="source" data-testid="spec-editor-source"></select>
      </label>
      <form id="form" data-testid="spec-editor-form"></form>
      <div class="actions">
        <button id="save" type="button" data-testid="spec-editor-save">Save config</button>
        <span id="saved" class="muted small"></span>
      </div>
    </div>

    <div class="group">
      <h2 id="output-heading">
        Output <span id="dataset-counts" class="muted" data-testid="spec-editor-dataset-counts"></span>
      </h2>
      <p class="muted small">What you want recorded for each item. Rows are the items; the labels are yours.</p>
      <div id="dataset-existing" hidden>
        <div class="row">
          <span id="dataset-title"></span>
          <small class="mono" id="dataset-shape" data-testid="spec-editor-dataset-shape"></small>
        </div>
      </div>
      <form id="dataset-form" data-testid="spec-editor-dataset-form">
        <label class="row">
          <span>Name</span>
          <input id="dataset-name" data-testid="spec-editor-dataset-name" placeholder="labels" />
        </label>
        <div id="shape-rows"></div>
        <div class="actions">
          <button id="shape-add" type="button" class="ghost" data-testid="spec-editor-shape-add">+ field</button>
          <button id="dataset-create" type="button" data-testid="spec-editor-dataset-create">Define output</button>
          <span id="dataset-error" class="err small"></span>
        </div>
      </form>
    </div>
  </section>

  <section class="pane" aria-labelledby="items-heading">
    <h2 id="items-heading">Items <span id="count" class="muted"></span></h2>
    <ul id="items" class="items" data-testid="spec-editor-items"></ul>
  </section>
</main>
`;

/** What to show in an empty label field.
 *
 * The field's own name already says what it holds, so a placeholder only earns
 * its place when the SHAPE is not obvious — a list needs to show it is comma
 * separated, a boolean needs its two words. Echoing the kind (`string`) would be
 * naming the field by how the system stores it, which tells the person nothing
 * they can act on. */
function placeholderFor(kind: unknown): string {
  if (Array.isArray(kind)) return 'a, b, c';
  if (kind === 'bool') return 'true or false';
  if (kind === 'int' || kind === 'float') return '0';
  return '';
}

const splitList = (text: string, sep: string) => text.split(sep).map((s) => s.trim()).filter(Boolean);

function fieldInput(field: any, value: any): HTMLInputElement | HTMLTextAreaElement {
  const type = field.type ?? 'text';
  if (type === 'lines') {
    const el = document.createElement('textarea');
    el.rows = 4;
    el.value = Array.isArray(value) ? value.join('\n') : (value ?? '');
    return el;
  }
  const el = document.createElement('input');
  el.type = type === 'number' ? 'number' : 'text';
  el.placeholder = field.placeholder ?? '';
  if (field.pattern) el.pattern = field.pattern;
  el.required = !!field.required;
  el.value = Array.isArray(value) ? value.join(', ') : (value ?? field.default ?? '');
  return el;
}

/**
 * A click button. Three of these differ only in their label, their handler and a
 * class, so the shape lives here rather than being spelled out each time.
 *
 * `type="button"` is not a detail: these sit inside `<form>`s, and the default
 * `submit` would reload the page out from under the app on every click.
 */
function button(
  label: string,
  onClick: (event: MouseEvent) => unknown,
  opts: { className?: string; testId?: string } = {},
): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  if (opts.className) el.className = opts.className;
  if (opts.testId) el.dataset.testid = opts.testId;
  el.addEventListener('click', (event) => void onClick(event));
  return el;
}

function readInput(field: any, el: any): any {
  const type = field.type ?? 'text';
  if (type === 'lines') return splitList(el.value, '\n');
  if (type === 'csv') return splitList(el.value, ',');
  if (type === 'number') return el.value === '' ? null : Number(el.value);
  return el.value;
}

/**
 * Render the source editor into `root` (default: `document.body`) and connect it.
 *
 * Returns when the editor is live. Rejects with the reason it could not start,
 * which the caller may show — the shipped apps let it surface in the status bar.
 */
export async function mountSourceEditor(root: HTMLElement = document.body): Promise<void> {
  // Before any markup exists, so a dark host never shows a light flash.
  applyHostTheme();
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.append(style);
  root.innerHTML = MARKUP;

  const $ = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
  const statusEl = $('status');

  try {
    await run($, statusEl);
  } catch (error: any) {
    statusEl.textContent = String(error?.message ?? error);
    statusEl.classList.add('err');
    throw error;
  }
}

async function run($: (id: string) => HTMLElement, statusEl: HTMLElement): Promise<void> {
  let spec: any = null;
  let sources: any[] = [];
  let current: any = null;
  let dataset: any = null;
  let items: any[] = [];
  const inputs = new Map<string, [any, any]>();
  /** item id → example id, from the dataset's `examples` listing and `promote` replies. */
  const promoted = new Map<string, string>();
  const labelled = new Set<string>();

  async function loadExamples() {
    promoted.clear();
    labelled.clear();
    if (!dataset) return;
    try {
      const out = await dataset.examples();
      for (const ex of out.examples ?? []) {
        if (ex.item_id) promoted.set(ex.item_id, ex.example_id);
        if (ex.annotated) labelled.add(ex.example_id);
      }
    } catch (error) {
      console.warn('[source editor] examples listing failed', error);
    }
  }

  // ── config form ────────────────────────────────────────────────────────
  function renderForm() {
    const form = $('form');
    form.replaceChildren();
    inputs.clear();
    if (!current) return;
    for (const [key, field] of Object.entries<any>(spec.config ?? {})) {
      const row = document.createElement('label');
      row.className = 'row';
      const label = document.createElement('span');
      label.textContent = field.label || key;
      const el = fieldInput(field, current.config?.[key]);
      el.dataset.testid = `spec-editor-field-${key}`;
      row.append(label, el);
      if (field.hint) {
        const hint = document.createElement('small');
        hint.textContent = field.hint;
        row.append(hint);
      }
      form.append(row);
      inputs.set(key, [field, el]);
    }
  }

  $('save').addEventListener('click', async () => {
    if (!current) return;
    const config = { ...(current.config ?? {}) };
    for (const [key, [field, el]] of inputs) config[key] = readInput(field, el);
    current.config = config;
    await current.save();
    $('saved').textContent = 'Saved';
  });

  // ── dataset pane ───────────────────────────────────────────────────────
  /** The authored output shape, as {nameEl, kindEl} rows — the elements ARE the
   *  state, so nothing re-reads the shape back out of the DOM by position. */
  const shapeRows: { nameEl: HTMLInputElement; kindEl: HTMLSelectElement; row: HTMLElement }[] = [];

  function addShapeRow(name = '') {
    const row = document.createElement('div');
    row.className = 'shape-row';
    const nameEl = document.createElement('input');
    nameEl.placeholder = 'field';
    nameEl.value = name;
    nameEl.dataset.testid = `spec-editor-shape-field-${shapeRows.length}`;
    const kindEl = document.createElement('select');
    for (const [i, opt] of KIND_OPTIONS.entries()) {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = opt.label;
      kindEl.append(o);
    }
    const entry = { nameEl, kindEl, row };
    const rm = button('×', () => {
      row.remove();
      shapeRows.splice(shapeRows.indexOf(entry), 1);
    }, { className: 'ghost' });
    row.append(nameEl, kindEl, rm);
    shapeRows.push(entry);
    $('shape-rows').append(row);
  }

  function readShape(): Record<string, unknown> {
    const shape: Record<string, unknown> = {};
    for (const { nameEl, kindEl } of shapeRows) {
      const name = nameEl.value.trim();
      if (name) shape[name] = KIND_OPTIONS[Number(kindEl.value)].value;
    }
    return shape;
  }

  $('shape-add').addEventListener('click', () => addShapeRow());

  $('dataset-create').addEventListener('click', async () => {
    $('dataset-error').textContent = '';
    if (!current) return;
    const output = readShape();
    if (!Object.keys(output).length) {
      $('dataset-error').textContent = 'Add at least one field.';
      return;
    }
    try {
      // A source is not project-scoped; the dataset is. The dock may name the
      // project (`?project=<id>`), else the SDK's current project.
      const projectParam = appOption('project');
      const projectTypeId = projectParam ? new TypeId('project', projectParam) : dataContext.projectTypeId;
      // Saving with no scope would place the dataset outside every project, where
      // the person's list never shows it — the app would look like it worked.
      if (!projectTypeId) throw new Error('no project in scope to save this dataset into');
      const name = ($('dataset-name') as HTMLInputElement).value.trim() || `${current.name} labels`;
      await Dataset.forSource(current.id, name, output).save(projectTypeId);
    } catch (error: any) {
      $('dataset-error').textContent = String(error?.message ?? error);
    }
  });

  /** The dataset header alone — the counts a write changes. Kept apart from
   *  `renderItems` so saving a label updates the numbers without rebuilding the
   *  row the person just typed into (which would take the form with it). */
  function renderDatasetHeader() {
    const has = !!dataset;
    ($('dataset-existing') as HTMLElement).hidden = !has;
    ($('dataset-form') as HTMLElement).hidden = has;
    if (has) {
      $('dataset-title').textContent = dataset.title || dataset.name;
      $('dataset-shape').textContent = JSON.stringify(dataset.outputShape ?? {});
      const examples = dataset.num_examples ?? 0;
      $('dataset-counts').textContent =
        `(${examples} ${examples === 1 ? 'example' : 'examples'} · ${dataset.num_annotated ?? 0} labelled)`;
    } else {
      $('dataset-counts').textContent = '';
      if (!shapeRows.length) addShapeRow('sentiment');
    }
  }

  function renderDataset() {
    renderDatasetHeader();
    renderItems();
  }

  let unwatchDataset: any = null;
  async function watchDataset() {
    if (unwatchDataset) unwatchDataset();
    dataset = null;
    if (!current) return renderDataset();
    unwatchDataset = await dataManager.watchQuery(
      new QueryRequest({
        type: 'dataset',
        query: { match: { source_id: current.id } },
        scope: [],
        name: `spec-editor-dataset-${current.id}`,
        callback: async (rows: any[]) => {
          const next = rows?.[0] ?? null;
          const changed = next?.id !== dataset?.id;
          dataset = next;
          // A different dataset means new rows to learn; the same one arriving
          // with fresh counts needs the header, not a full item pass (the item
          // states are unchanged, and `renderItems` no-ops on them anyway).
          if (changed) await loadExamples();
          renderDataset();
        },
      } as any),
    );
  }

  // ── items ──────────────────────────────────────────────────────────────
  function labelForm(item: any, exampleId: string, li: HTMLElement) {
    const box = document.createElement('div');
    box.className = 'label';
    const shape = dataset?.outputShape ?? {};
    const fields = new Map<string, [any, HTMLInputElement]>();
    for (const [name, kind] of Object.entries<any>(shape)) {
      const f = document.createElement('div');
      f.className = 'field';
      const l = document.createElement('span');
      l.textContent = name;
      const el = document.createElement('input');
      el.dataset.testid = `spec-editor-label-${name}`;
      el.placeholder = placeholderFor(kind);
      f.append(l, el);
      box.append(f);
      fields.set(name, [kind, el]);
    }
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const msg = document.createElement('span');
    msg.className = 'muted small';
    const save = button('Save label', async () => {
      const gold: Record<string, unknown> = {};
      for (const [name, [kind, el]] of fields) gold[name] = coerceToKind(kind, el.value.trim());
      try {
        const out = await dataset.annotate(exampleId, gold);
        labelled.add(exampleId);
        dataset.num_annotated = out.num_annotated; // the action already returns the derived count
        msg.textContent = `labelled (${out.num_annotated} total)`;
        msg.dataset.testid = 'spec-editor-annotated';
        // Move the row to its new state IN PLACE: a rebuild here would discard
        // this very message (and the form it sits under).
        const tag = li.querySelector('.tag');
        if (tag) tag.textContent = 'labelled';
        li.dataset.state = itemState(item);
        renderDatasetHeader();
      } catch (error: any) {
        msg.textContent = String(error?.message ?? error);
      }
    }, { testId: 'spec-editor-annotate-save' });
    actions.append(save, msg);
    box.append(actions);
    return box;
  }

  function itemNode(item: any) {
    const li = document.createElement('li');
    li.dataset.id = item.id;
    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = item.name || item.external_id || item.id;
    const meta = document.createElement('small');
    meta.textContent = [item.author_display, item.occurred_at].filter(Boolean).join(' · ');
    li.append(title, meta);
    return li;
  }

  /** What an item's row should currently show — the whole per-item state in one
   *  comparable string, so a re-render rebuilds a row only when it really changed
   *  (and never under a click or a half-typed label). */
  function itemState(item: any): string {
    const exampleId = dataset ? promoted.get(item.id) : null;
    if (!exampleId) return dataset ? 'promote' : 'bare';
    return `label:${exampleId}:${labelled.has(exampleId)}`;
  }

  /** Idempotent: nodes are keyed by item id and only the missing parts are
   *  added, so a watch callback never replaces a button under a click or a
   *  label under a person's typing. */
  function renderItems() {
    const list = $('items');
    const byId = new Map([...list.children].map((li: any) => [li.dataset.id, li as HTMLElement]));
    const keep = new Set<string>();
    for (const item of items) {
      keep.add(item.id);
      let li = byId.get(item.id);
      if (!li) {
        li = itemNode(item);
        list.append(li);
      }
      const state = itemState(item);
      if (li.dataset.state === state) continue;
      li.dataset.state = state;
      li.querySelector('.item-actions')?.remove();
      li.querySelector('.label')?.remove();
      li.querySelector('.tag')?.remove();
      if (state.startsWith('label:')) {
        const exampleId = promoted.get(item.id)!;
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = labelled.has(exampleId) ? 'labelled' : 'example';
        li.querySelector('.item-title')!.append(' ', tag);
        li.append(labelForm(item, exampleId, li));
      } else if (state === 'promote') {
        const actions = document.createElement('div');
        actions.className = 'item-actions';
        const btn = button('Promote', async () => {
          btn.disabled = true;
          try {
            const out = await dataset.promote([item.id]);
            promoted.set(item.id, out.example_ids[0]);
            dataset.num_examples = out.num_examples; // the action returns the derived count
            renderDataset();
          } catch (error: any) {
            btn.disabled = false;
            btn.textContent = String(error?.message ?? error);
          }
        }, { className: 'ghost', testId: `spec-editor-promote-${item.id}` });
        actions.append(btn);
        li.append(actions);
      }
    }
    for (const [id, li] of byId) if (!keep.has(id!)) li.remove();
    $('count').textContent = `(${items.length})`;
  }

  let unwatchItems: any = null;
  async function watchItems() {
    if (unwatchItems) unwatchItems();
    items = [];
    renderItems();
    if (!current) return;
    unwatchItems = await dataManager.watchQuery(
      new QueryRequest({
        type: 'source_item',
        query: { match: { data_source_id: current.id }, limit: 200 },
        scope: [],
        name: `spec-editor-items-${current.id}`,
        callback: (rows: any[]) => {
          items = rows ?? [];
          renderItems();
        },
      } as any),
    );
  }

  function selectSource(id: string) {
    current = sources.find((s) => s.id === id) ?? null;
    $('saved').textContent = '';
    renderForm();
    void watchDataset();
    void watchItems();
  }

  $('source').addEventListener('change', (e: any) => selectSource(e.target.value));

  // a guest: never mint a tab/workspace for the host
  await initSdk({ setupWorkspace: false });
  // The subject is the asset this app is nested inside — its parent.
  const { subject } = await resolveAppHost();
  if (!subject) throw new Error('this app has no parent asset to edit');
  spec = subject;
  $('title').textContent = (spec as any).title || (spec as any).name;

  const wanted = appOption('source');
  await dataManager.watchQuery(
    new QueryRequest({
      type: 'data_source',
      query: { match: { provider: (spec as any).name } },
      scope: [],
      name: `spec-editor-sources-${spec.id}`,
      callback: (rows: any[]) => {
        sources = rows ?? [];
        const sel = $('source') as HTMLSelectElement;
        // Only rebuild when the OPTIONS changed. This watch fires on any field
        // of any source for the provider, and `last_synced_at` / `next_poll_at`
        // tick on every poll — replacing the nodes each time would churn a
        // control the person may have open, forever, for no visible change.
        const shape = sources.map((s) => `${s.id}:${s.name || s.id}`).join('\n');
        if (sel.dataset.shape !== shape) {
          sel.dataset.shape = shape;
          sel.replaceChildren(
            ...sources.map((s) => {
              const o = document.createElement('option');
              o.value = s.id;
              o.textContent = s.name || s.id;
              return o;
            }),
          );
        }
        const keep = current?.id ?? wanted ?? sources[0]?.id;
        if (!keep) return;
        sel.value = keep;
        if (current?.id === keep) current = sources.find((s) => s.id === keep) ?? current; // same row, fresh object
        else selectSource(keep);
      },
    } as any),
  );
  statusEl.textContent = 'Live';
  statusEl.classList.add('ok');
  ($('main') as HTMLElement).hidden = false;
  // `initSdk` schedules `asyncSdkInit` itself now -- the double-rAF this used to
  // hand-roll is redundant, and was the same step every other SDK consumer had to
  // remember (and template-flowpad did not).
}

// The builtin "spec" editor: a form over a source definition's `config`
// catalog, the source's live items, and the dataset pane — the output shape the
// person wants per item, plus promote/label for each item.
// Served for every data_source_spec at
//   /api/v1/graph/data_source_spec/<id>/editor/spec/?source=<data_source id>
// It learns everything else from the SDK — no URL is written here.
import * as sdk from '/sdk/flowpad-sdk.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
//: The kind options a person picks from: the SDK's declared kinds plus the
//: one-element list form. `value` is what the shape carries, so nothing here
//: parses JSON out of a <select>.
const KIND_OPTIONS = [
  ...sdk.DATASET_FIELD_KINDS.map((k) => ({ label: k, value: k })),
  { label: 'list of string', value: ['string'] },
];

/** The host entity is in this page's own path: /graph/<type>/<id>/editor/<name>/ */
function hostTypeId() {
  const m = location.pathname.match(/graph\/([a-z_]+)\/([^/]+)\/editor\//i);
  return m ? new sdk.TypeId(m[1], m[2]) : null;
}

const splitList = (text, sep) => text.split(sep).map((s) => s.trim()).filter(Boolean);

function fieldInput(field, value) {
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

function readInput(field, el) {
  const type = field.type ?? 'text';
  if (type === 'lines') return splitList(el.value, '\n');
  if (type === 'csv') return splitList(el.value, ',');
  if (type === 'number') return el.value === '' ? null : Number(el.value);
  return el.value;
}

let spec = null;
let sources = [];
let current = null;
let dataset = null;
let items = [];
const inputs = new Map();
/** item id → example id, from the dataset's `examples` listing and `promote` replies. */
const promoted = new Map();
const labelled = new Set();

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
    console.warn('[spec editor] examples listing failed', error);
  }
}

// ── config form ──────────────────────────────────────────────────────────

function renderForm() {
  const form = $('form');
  form.replaceChildren();
  inputs.clear();
  if (!current) return;
  for (const [key, field] of Object.entries(spec.config ?? {})) {
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

// ── dataset pane ─────────────────────────────────────────────────────────

/** The authored output shape, as {nameEl, kindEl} rows — the elements ARE the
 *  state, so nothing re-reads the shape back out of the DOM by position. */
const shapeRows = [];

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
  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'ghost';
  rm.textContent = '×';
  const entry = { nameEl, kindEl, row };
  rm.addEventListener('click', () => {
    row.remove();
    shapeRows.splice(shapeRows.indexOf(entry), 1);
  });
  row.append(nameEl, kindEl, rm);
  shapeRows.push(entry);
  $('shape-rows').append(row);
}

function readShape() {
  const shape = {};
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
    const projectParam = new URLSearchParams(location.search).get('project');
    const projectTypeId = projectParam ? new sdk.TypeId('project', projectParam) : sdk.dataContext.projectTypeId;
    const name = $('dataset-name').value.trim() || `${current.name} labels`;
    await sdk.Dataset.forSource(current.id, name, output).save(projectTypeId);
  } catch (error) {
    $('dataset-error').textContent = String(error?.message ?? error);
  }
});

/** The dataset header alone — the counts a write changes. Kept apart from
 *  `renderItems` so saving a label updates the numbers without rebuilding the
 *  row the person just typed into (which would take the form with it). */
function renderDatasetHeader() {
  const has = !!dataset;
  $('dataset-existing').hidden = !has;
  $('dataset-form').hidden = has;
  if (has) {
    $('dataset-title').textContent = dataset.title || dataset.name;
    $('dataset-shape').textContent = JSON.stringify(dataset.outputShape ?? {});
    $('dataset-counts').textContent = `(${dataset.num_examples ?? 0} examples · ${dataset.num_annotated ?? 0} labelled)`;
  } else {
    $('dataset-counts').textContent = '';
    if (!shapeRows.length) addShapeRow('sentiment');
  }
}

function renderDataset() {
  renderDatasetHeader();
  renderItems();
}

let unwatchDataset = null;
async function watchDataset() {
  if (unwatchDataset) unwatchDataset();
  dataset = null;
  if (!current) return renderDataset();
  unwatchDataset = await sdk.dataManager.watchQuery(
    new sdk.QueryRequest({
      type: 'dataset',
      query: { match: { source_id: current.id } },
      scope: [],
      name: `spec-editor-dataset-${current.id}`,
      callback: async (rows) => {
        const next = rows?.[0] ?? null;
        const changed = next?.id !== dataset?.id;
        dataset = next;
        // A different dataset means new rows to learn; the same one arriving
        // with fresh counts needs the header, not a full item pass (the item
        // states are unchanged, and `renderItems` no-ops on them anyway).
        if (changed) await loadExamples();
        renderDataset();
      },
    }),
  );
}

// ── items ────────────────────────────────────────────────────────────────

function labelForm(item, exampleId, li) {
  const box = document.createElement('div');
  box.className = 'label';
  const shape = dataset?.outputShape ?? {};
  const fields = new Map();
  for (const [name, kind] of Object.entries(shape)) {
    const f = document.createElement('div');
    f.className = 'field';
    const l = document.createElement('span');
    l.textContent = name;
    const el = document.createElement('input');
    el.dataset.testid = `spec-editor-label-${name}`;
    el.placeholder = Array.isArray(kind) ? 'a, b, c' : kind;
    f.append(l, el);
    box.append(f);
    fields.set(name, [kind, el]);
  }
  const actions = document.createElement('div');
  actions.className = 'item-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = 'Save label';
  save.dataset.testid = 'spec-editor-annotate-save';
  const msg = document.createElement('span');
  msg.className = 'muted small';
  save.addEventListener('click', async () => {
    const gold = {};
    for (const [name, [kind, el]] of fields) gold[name] = sdk.coerceToKind(kind, el.value.trim());
    try {
      const out = await dataset.annotate(exampleId, gold);
      labelled.add(exampleId);
      dataset.num_annotated = out.num_annotated;   // the action already returns the derived count
      msg.textContent = `labelled (${out.num_annotated} total)`;
      msg.dataset.testid = 'spec-editor-annotated';
      // Move the row to its new state IN PLACE: a rebuild here would discard
      // this very message (and the form it sits under).
      const tag = li.querySelector('.tag');
      if (tag) tag.textContent = 'labelled';
      li.dataset.state = itemState(item);
      renderDatasetHeader();
    } catch (error) {
      msg.textContent = String(error?.message ?? error);
    }
  });
  actions.append(save, msg);
  box.append(actions);
  return box;
}

function itemNode(item) {
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

/** Idempotent: nodes are keyed by item id and only the missing parts are added,
 *  so a watch callback never replaces a button under a click or a label under
 *  a person's typing. */
/** What an item's row should currently show — the whole per-item state in one
 *  comparable string, so a re-render rebuilds a row only when it really changed
 *  (and never under a click or a half-typed label). */
function itemState(item) {
  const exampleId = dataset ? promoted.get(item.id) : null;
  if (!exampleId) return dataset ? 'promote' : 'bare';
  return `label:${exampleId}:${labelled.has(exampleId)}`;
}

function renderItems() {
  const list = $('items');
  const byId = new Map([...list.children].map((li) => [li.dataset.id, li]));
  const keep = new Set();
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
      const exampleId = promoted.get(item.id);
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = labelled.has(exampleId) ? 'labelled' : 'example';
      li.querySelector('.item-title').append(' ', tag);
      li.append(labelForm(item, exampleId, li));
    } else if (state === 'promote') {
      const actions = document.createElement('div');
      actions.className = 'item-actions';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Promote';
      btn.dataset.testid = `spec-editor-promote-${item.id}`;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const out = await dataset.promote([item.id]);
          promoted.set(item.id, out.example_ids[0]);
          dataset.num_examples = out.num_examples;   // the action returns the derived count
          renderDataset();
        } catch (error) {
          btn.disabled = false;
          btn.textContent = String(error?.message ?? error);
        }
      });
      actions.append(btn);
      li.append(actions);
    }
  }
  for (const [id, li] of byId) if (!keep.has(id)) li.remove();
  $('count').textContent = `(${items.length})`;
}

let unwatchItems = null;
async function watchItems() {
  if (unwatchItems) unwatchItems();
  items = [];
  renderItems();
  if (!current) return;
  unwatchItems = await sdk.dataManager.watchQuery(
    new sdk.QueryRequest({
      type: 'source_item',
      query: { match: { data_source_id: current.id }, limit: 200 },
      scope: [],
      name: `spec-editor-items-${current.id}`,
      callback: (rows) => {
        items = rows ?? [];
        renderItems();
      },
    }),
  );
}

function selectSource(id) {
  current = sources.find((s) => s.id === id) ?? null;
  $('saved').textContent = '';
  renderForm();
  void watchDataset();
  void watchItems();
}

$('source').addEventListener('change', (e) => selectSource(e.target.value));

async function main() {
  await sdk.initSdk({ setupWorkspace: false }); // a guest: never mint a tab/workspace for the host
  const host = hostTypeId();
  if (!host) throw new Error('not served from an asset editor URL');
  spec = await sdk.dataManager.getByTypeId(host);
  if (!spec) throw new Error(`no ${host}`);
  $('title').textContent = spec.title || spec.name;

  const wanted = new URLSearchParams(location.search).get('source');
  await sdk.dataManager.watchQuery(
    new sdk.QueryRequest({
      type: 'data_source',
      query: { match: { provider: spec.name } },
      scope: [],
      name: `spec-editor-sources-${spec.id}`,
      callback: (rows) => {
        sources = rows ?? [];
        const sel = $('source');
        sel.replaceChildren(
          ...sources.map((s) => {
            const o = document.createElement('option');
            o.value = s.id;
            o.textContent = s.name || s.id;
            return o;
          }),
        );
        const keep = current?.id ?? wanted ?? sources[0]?.id;
        if (!keep) return;
        sel.value = keep;
        if (current?.id === keep) current = sources.find((s) => s.id === keep) ?? current; // same row, fresh object
        else selectSource(keep);
      },
    }),
  );
  statusEl.textContent = 'Live';
  statusEl.classList.add('ok');
  $('main').hidden = false;
}

main().catch((error) => {
  statusEl.textContent = String(error?.message ?? error);
  statusEl.classList.add('err');
});

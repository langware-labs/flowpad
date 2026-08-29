// The builtin "spec" editor: a form over a source definition's `config`
// catalog, applied to the DataSources of that definition, plus their items.
// Served for every data_source_spec at
//   /api/v1/graph/data_source_spec/<id>/editor/spec/?source=<data_source id>
// It learns everything else from the SDK — no URL is written here.
import * as sdk from '/sdk/flowpad-sdk.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

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
const inputs = new Map();

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

let unwatchItems = null;
async function watchItems() {
  if (unwatchItems) unwatchItems();
  $('items').replaceChildren();
  $('count').textContent = '';
  if (!current) return;
  unwatchItems = await sdk.dataManager.watchQuery(
    new sdk.QueryRequest({
      type: 'source_item',
      query: { match: { data_source_id: current.id }, limit: 200 },
      scope: [],
      name: `spec-editor-items-${current.id}`,
      callback: (rows) => {
        const list = $('items');
        list.replaceChildren(
          ...(rows ?? []).map((item) => {
            const li = document.createElement('li');
            li.textContent = item.name || item.external_id || item.id;
            const meta = document.createElement('small');
            meta.textContent = [item.author_display, item.occurred_at].filter(Boolean).join(' · ');
            li.append(meta);
            return li;
          }),
        );
        $('count').textContent = `(${rows?.length ?? 0})`;
      },
    }),
  );
}

function selectSource(id) {
  current = sources.find((s) => s.id === id) ?? null;
  $('saved').textContent = '';
  renderForm();
  void watchItems();
}

$('source').addEventListener('change', (e) => selectSource(e.target.value));

$('save').addEventListener('click', async () => {
  if (!current) return;
  const config = { ...(current.config ?? {}) };
  for (const [key, [field, el]] of inputs) config[key] = readInput(field, el);
  current.config = config;
  await current.save();
  $('saved').textContent = 'Saved';
});

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

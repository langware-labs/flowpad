/**
 * The dataset editor, as an SDK-provided app: browse a dataset's examples and label them.
 *
 * Shape-driven, never dataset-specific. It reads the kind the dataset DECLARES (`spec`, e.g.
 * `navigator.dataset`) from `GET /api/v1/kinds/<kind>`, then the kinds of its slots, and builds
 * every form from those definitions: an `enum:` field is a select, a `?` field may be left empty,
 * a field naming another kind is a nested group, and a field's description is its hint. So one
 * editor serves every typed dataset, and improving it is one edit rather than one per dataset.
 *
 * Mounted by a webapp asset in three lines — nested inside a dataset (it edits its parent), or
 * shipped on its own with `edits: ["dataset"]`, opened with `?subject=dataset-<id>`.
 */
import apiClient from '../client';
import { initSdk } from '../main';
import { DATASET_FIELD_KINDS, Dataset, coerceToKind } from '../entities/dataset';
import { applyHostTheme, resolveAppHost } from './host';

interface FieldDef {
  shape: unknown;
  description?: string;
  required?: boolean;
}
interface KindForm {
  kind: string;
  subkind: 'record' | 'dataset';
  description?: string;
  fields?: Record<string, FieldDef>;
  slots?: Record<string, unknown>;
}

const STYLES = `
@layer base, rows;
@layer base {
  body { font: 14px/1.55 var(--font-sans); margin: 0; }
  header { display: flex; gap: .75rem; align-items: center; padding: .75rem 1rem; border-bottom: 1px solid hsl(var(--border)); }
  header h1 { font-size: 15px; margin: 0; }
  .muted { color: hsl(var(--muted-foreground)); } .small { font-size: 12px; }
  .mono { font-family: var(--font-mono); font-size: 12px; }
  .err { color: hsl(var(--destructive)); } .ok { color: hsl(142 70% 45%); }
  button { font: inherit; padding: .2rem .6rem; border-radius: 6px; border: 1px solid hsl(var(--border)); background: hsl(var(--secondary)); color: inherit; cursor: pointer; }
  select, input, textarea { font: inherit; padding: .2rem .4rem; border-radius: 6px; border: 1px solid hsl(var(--border)); background: hsl(var(--background)); color: inherit; }
}
@layer rows {
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; vertical-align: top; padding: .4rem .75rem; border-bottom: 1px solid hsl(var(--border)); }
  th { font-size: 12px; font-weight: 600; color: hsl(var(--muted-foreground)); }
  tr.example { cursor: pointer; } tr.example:hover { background: hsl(var(--muted) / .4); }
  .form { display: grid; gap: .4rem; padding: .5rem 0; }
  .field { display: grid; grid-template-columns: 9rem 1fr; gap: .5rem; align-items: start; }
  .group { border-left: 2px solid hsl(var(--border)); padding-left: .6rem; display: grid; gap: .35rem; }
}`;

const MARKUP = `
<header>
  <h1 id="title" data-testid="dataset-editor-title">Dataset</h1>
  <span id="kind" class="mono muted" data-testid="dataset-editor-kind"></span>
  <span id="counts" class="muted small" data-testid="dataset-editor-counts"></span>
  <span style="flex:1"></span>
  <select id="filter" data-testid="dataset-editor-filter"><option value="">all</option><option>train</option><option>eval</option><option>test</option></select>
  <button type="button" id="validate" data-testid="dataset-editor-validate">Validate</button>
  <span id="status" class="small"></span>
</header>
<table><thead><tr><th>#</th><th>role</th><th>input</th><th>gold</th><th>output</th></tr></thead>
<tbody id="rows" data-testid="dataset-editor-rows"></tbody></table>`;

/** A one-line summary of a slot value: a request's utterance, a decision's route + target. */
export function summarize(value: unknown): string {
  if (value == null) return '—';
  if (Array.isArray(value)) return value.map(summarize).join('  |  ');
  if (typeof value !== 'object') return String(value);
  const v = value as Record<string, any>;
  if (typeof v.utterance === 'string') return v.utterance;
  if (v.route)
    return v.target
      ? `${v.route} → ${v.target.kind}:${v.target.value}${v.verb && v.verb !== 'show' ? ` (${v.verb})` : ''}`
      : v.route;
  return JSON.stringify(v);
}

const PRIMITIVES: ReadonlySet<string> = new Set(DATASET_FIELD_KINDS);

const kindCache = new Map<string, Promise<KindForm | null>>();
/** A registered kind's definition, or null for a primitive / enum / unknown name. A failed
 *  lookup is not remembered, so a transient error is retried on the next open. */
export function kindForm(kind: string): Promise<KindForm | null> {
  if (!kind || kind.startsWith('enum:') || PRIMITIVES.has(kind)) return Promise.resolve(null);
  if (!kindCache.has(kind)) {
    kindCache.set(
      kind,
      apiClient.get<KindForm>(`/api/v1/kinds/${encodeURIComponent(kind)}`).catch(() => {
        kindCache.delete(kind);
        return null;
      }),
    );
  }
  return kindCache.get(kind)!;
}

/** Build an input for one field from its shape; returns the element and a reader of its value. */
async function fieldInput(name: string, def: FieldDef, value: any): Promise<[HTMLElement, () => any]> {
  let shape = def.shape;
  const optional = typeof shape === 'string' && shape.startsWith('?');
  if (optional) shape = (shape as string).slice(1);
  if (typeof shape === 'string' && shape.startsWith('enum:')) {
    const sel = document.createElement('select');
    sel.dataset.testid = `dataset-editor-field-${name}`;
    const values = shape.slice(5).split('|');
    sel.replaceChildren(
      ...(optional ? [''] : [])
        .concat(values)
        .map((v) => Object.assign(document.createElement('option'), { value: v, textContent: v || '—' })),
    );
    sel.value = value ?? (optional ? '' : values[0]);
    return [sel, () => (sel.value === '' ? null : sel.value)];
  }
  const nested = typeof shape === 'string' ? await kindForm(shape) : null;
  if (nested?.fields) {
    const group = document.createElement('div');
    group.className = 'group';
    const readers: [string, () => any][] = [];
    for (const [child, childDef] of Object.entries(nested.fields)) {
      const [el, read] = await fieldInput(`${name}.${child}`, childDef, value?.[child]);
      group.append(fieldRow(child, childDef, el));
      readers.push([child, read]);
    }
    const read = () => {
      const out: Record<string, any> = {};
      for (const [child, r] of readers) out[child] = r();
      return optional && Object.values(out).every((v) => v == null || v === '') ? null : out;
    };
    return [group, read];
  }
  // A list, a map, or an unknown shape: edited as JSON, checked by the server on save.
  if (typeof shape !== 'string' || !PRIMITIVES.has(shape)) {
    const ta = document.createElement('textarea');
    ta.rows = 3;
    ta.className = 'mono';
    ta.dataset.testid = `dataset-editor-field-${name}`;
    ta.value = value == null ? '' : JSON.stringify(value, null, 1);
    return [ta, () => (ta.value.trim() ? JSON.parse(ta.value) : null)];
  }
  const input = document.createElement('input');
  input.dataset.testid = `dataset-editor-field-${name}`;
  input.value = value ?? '';
  return [input, () => (input.value === '' ? (optional ? null : '') : coerceToKind(shape, input.value))];
}

function fieldRow(name: string, def: FieldDef, el: HTMLElement): HTMLElement {
  const f = document.createElement('label');
  f.className = 'field';
  const l = document.createElement('span');
  l.append(Object.assign(document.createElement('span'), { className: 'mono', textContent: name }));
  if (def.description) {
    l.append(Object.assign(document.createElement('div'), { className: 'muted small', textContent: def.description }));
  }
  f.append(l, el);
  return f;
}

/** Render the dataset editor into `root` and connect it. Rejects with why it could not start. */
export async function mountDatasetEditor(root: HTMLElement = document.body): Promise<void> {
  applyHostTheme();
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.append(style);
  root.innerHTML = MARKUP;
  const $ = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
  try {
    await run($);
  } catch (error: any) {
    $('status').textContent = String(error?.message ?? error);
    $('status').classList.add('err');
    throw error;
  }
}

async function run($: (id: string) => HTMLElement): Promise<void> {
  await initSdk({ setupWorkspace: false });
  // Nested: the dataset containing this app. Matched by kind: `?subject=` (resolveAppHost reads both).
  const found: any = (await resolveAppHost()).subject;
  if (!found || found.type !== 'dataset') throw new Error('this editor needs a dataset to edit');
  // The lookup answers a plain row; the actions (examples, annotate, validate) live on the class.
  const dataset: any = found instanceof Dataset ? found : new Dataset(found);
  $('title').textContent = dataset.title || dataset.name;
  const kind = typeof dataset.spec === 'string' ? dataset.spec : '';
  $('kind').textContent = kind;
  const form = kind ? await kindForm(kind) : null;
  const goldKind = typeof form?.slots?.output === 'string' ? (form.slots.output as string) : '';
  const gold = goldKind ? await kindForm(goldKind) : null;

  const { rows } = await dataset.rows(); // every example with its values, in one request
  const counts = () => `${rows.length} examples · ${rows.filter((r) => r.ground_truth != null).length} labelled`;
  $('counts').textContent = counts();

  const body = $('rows');
  const render = () => {
    const role = ($('filter') as HTMLSelectElement).value;
    body.replaceChildren();
    rows.forEach((r, n) => {
      if (role && r.kind !== role) return;
      const tr = document.createElement('tr');
      tr.className = 'example';
      tr.dataset.testid = `dataset-editor-row-${n + 1}`;
      tr.innerHTML = `<td class="mono">${n + 1}</td><td>${r.kind}</td><td></td><td></td><td class="muted"></td>`;
      tr.children[2].textContent = summarize(r.input);
      tr.children[3].textContent = summarize(r.ground_truth);
      tr.children[4].textContent = summarize(r.output);
      tr.addEventListener('click', () => void open(tr, r));
      body.append(tr);
    });
  };

  async function open(tr: HTMLElement, r: any) {
    if (tr.nextElementSibling?.classList.contains('editing')) return tr.nextElementSibling.remove();
    const holder = document.createElement('tr');
    holder.className = 'editing';
    const td = document.createElement('td');
    td.colSpan = 5;
    const box = document.createElement('div');
    box.className = 'form';
    box.dataset.testid = 'dataset-editor-form';
    const ctx = document.createElement('pre');
    ctx.className = 'mono muted small';
    ctx.textContent = JSON.stringify({ input: r.input, context: r.context, data: r.data }, null, 1);
    box.append(ctx);
    const golds = Array.isArray(r.ground_truth) ? r.ground_truth : [r.ground_truth];
    let read: () => any;
    if (gold?.fields && golds.length <= 1) {
      const readers: [string, () => any][] = [];
      for (const [name, def] of Object.entries(gold.fields)) {
        if (name === 'confidence') continue; // a producer's, never a label's
        const [el, rd] = await fieldInput(name, def, golds[0]?.[name]);
        box.append(fieldRow(name, def, el));
        readers.push([name, rd]);
      }
      read = () => Object.fromEntries(readers.map(([n, rd]) => [n, rd()]));
    } else {
      const [el, rd] = await fieldInput('ground_truth', { shape: [goldKind] }, r.ground_truth);
      box.append(
        fieldRow('ground_truth', { shape: [goldKind], description: 'several right answers — any one counts' }, el),
      );
      read = rd;
    }
    const msg = document.createElement('span');
    msg.className = 'small';
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save label';
    save.dataset.testid = 'dataset-editor-save';
    save.addEventListener('click', async () => {
      try {
        const value = read();
        await dataset.annotate(r.id, value);
        r.ground_truth = value;
        msg.textContent = 'saved';
        msg.className = 'small ok';
        tr.children[3].textContent = summarize(value);
        $('counts').textContent = counts();
      } catch (error: any) {
        msg.textContent = String(error?.response?.data?.message ?? error?.message ?? error);
        msg.className = 'small err';
      }
    });
    box.append(save, msg);
    td.append(box);
    holder.append(td);
    tr.after(holder);
  }

  $('filter').addEventListener('change', render);
  $('validate').addEventListener('click', async () => {
    const out = await dataset.validate();
    $('status').textContent = out.problems.length
      ? `${out.problems.length} rows do not fit`
      : `all ${out.checked} rows fit`;
    $('status').className = `small ${out.problems.length ? 'err' : 'ok'}`;
  });
  render();
  $('status').textContent = 'Live';
  $('status').classList.add('ok');
}

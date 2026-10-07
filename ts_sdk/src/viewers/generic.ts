/**
 * The generic data viewer — shows ANY kind from its definition alone, in every mode.
 *
 * It is the fallback for a kind no viewer claims, and what the `data-viewer` asset ships for `*`.
 * It knows the shape grammar and nothing about any dataset: a record is its fields, a dataset
 * example is its slots, a list is its items — and every nested value goes back through
 * `ctx.render`, so a kind with a viewer of its own is drawn by it wherever it appears.
 */
import { coerceToKind } from '../entities/dataset';
import type {
  CollectionRequest,
  CollectionViewer,
  FieldDef,
  KindForm,
  Mounted,
  Shape,
  SingleViewer,
  ViewerContext,
  ViewerMode,
  ViewRequest,
} from './contract';
import { PRIMITIVES, namedKind, unwrap } from './kinds';

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

/** A value as `{path: leaf}` — `{target: {kind: 'view'}}` → `{'target.kind': 'view'}`. */
export function flatten(value: unknown, prefix = ''): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return prefix ? { [prefix]: value } : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) Object.assign(out, flatten(v, prefix ? `${prefix}.${k}` : k));
  return out;
}

/** The right answer vs what was answered, field by field. A field the right answer leaves unset is
 *  free — never a difference. */
export function goldDiff(gold: unknown, answered: unknown): { path: string; gold: unknown; answered: unknown; differs: boolean }[] {
  const g = flatten(gold);
  const a = flatten(answered);
  return [...new Set([...Object.keys(g), ...Object.keys(a)])].sort().map((path) => ({
    path,
    gold: g[path],
    answered: a[path],
    differs: g[path] != null && JSON.stringify(g[path]) !== JSON.stringify(a[path]),
  }));
}

/** A plain value in one line. */
export function plain(value: unknown): string {
  if (value == null || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** The fields of a record shape: a registered kind's, or an inline `{field: shape}`. */
function fieldsOf(form: KindForm | null, base: Shape): Record<string, FieldDef> | null {
  if (form?.fields) return form.fields;
  if (base && typeof base === 'object' && !Array.isArray(base))
    return Object.fromEntries(Object.entries(base).map(([k, s]) => [k, { shape: s }]));
  return null;
}

/** The example slots of a dataset kind, as `[slot, row key, shape]` — the right answer is the row's
 *  `ground_truth`, read as the `output` slot's kind. */
export function datasetSlots(form: KindForm): { slot: string; key: string; shape: Shape }[] {
  const s = form.slots ?? {};
  return [
    s.input != null && { slot: 'input', key: 'input', shape: s.input },
    s.context != null && { slot: 'context', key: 'context', shape: s.context },
    s.output != null && { slot: 'output', key: 'ground_truth', shape: s.output },
  ].filter(Boolean) as { slot: string; key: string; shape: Shape }[];
}

// ── the viewer ────────────────────────────────────────────────────────────────

const empty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && !v.length);

async function mountSingle(el: HTMLElement, req: ViewRequest, ctx: ViewerContext): Promise<Mounted> {
  const { h } = ctx;
  const mode: ViewerMode = req.mode ?? 'view';
  const { optional, base } = unwrap(req.kind);
  el.replaceChildren();
  // A dataset kind is an example: its slots, each by its own kind (compare included).
  const form = typeof base === 'string' ? await ctx.kindForm(base) : null;
  if (form?.subkind === 'dataset') return mountExample(el, req, form, ctx);
  // Every other shape compares the same way: field by field.
  if (mode === 'compare') return mountCompare(el, req, ctx);

  // A list: its items, each by the item kind; a list of a registered kind is a COLLECTION of it.
  if (Array.isArray(base)) {
    const item = base[0] ?? 'string';
    const items = Array.isArray(req.value) ? req.value : [];
    if (mode === 'line') {
      el.append(h('span', { class: 'dv-muted' }, items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : '—'));
      return {};
    }
    if (mode === 'edit') return mountJson(el, req, ctx, optional);
    if (!items.length) return (el.append(h('span', { class: 'dv-muted' }, '—')), {});
    if (namedKind(item)) return ctx.renderCollection(el, { kind: item, items, meta: req.meta, on: req.on });
    el.append(h('div', { class: 'dv-chips' }, ...items.map((v) => h('span', { class: 'dv-chip' }, plain(v)))));
    return {};
  }

  // An enum or a primitive: a value, a select, an input.
  if (typeof base === 'string' && (base.startsWith('enum:') || PRIMITIVES.has(base))) {
    if (mode === 'edit') return mountInput(el, base, req.value, optional, h);
    const text = plain(req.value);
    el.append(base.startsWith('enum:') && req.value != null ? h('span', { class: 'dv-tag' }, text) : h('span', { class: text === '—' ? 'dv-muted' : '' }, text));
    return {};
  }

  const fields = fieldsOf(form, base);
  if (!fields) {
    if (mode === 'edit') return mountJson(el, req, ctx, optional);
    el.append(h(mode === 'line' ? 'span' : 'pre', { class: 'dv-mono' }, plain(req.value)));
    return {};
  }
  const omit = new Set((req.meta?.omit as string[] | undefined) ?? []);
  const entries = Object.entries(fields).filter(([name]) => !omit.has(name));
  const value = (req.value ?? {}) as Record<string, unknown>;

  if (mode === 'line') {
    if (req.value == null) return (el.append(h('span', { class: 'dv-muted' }, '—')), {});
    const parts = entries.filter(([name]) => !empty(value[name])).slice(0, 3);
    await Promise.all(parts.map(([name, def], i) => {
      if (i) el.append(h('span', { class: 'dv-sep' }, ' · '));
      const span = h('span');
      el.append(span);
      return ctx.render(span, { kind: def.shape, value: value[name], mode: 'line', meta: req.meta });
    }));
    return {};
  }

  if (mode === 'edit') {
    const box = h('div', { class: 'dv-form' });
    el.append(box);
    const readers: [string, () => unknown][] = [];
    for (const [name, def] of entries) {
      const cell = h('div');
      box.append(fieldRow(h, name, def, cell));
      const child = await ctx.render(cell, { kind: def.shape, value: value[name], mode: 'edit', meta: { ...req.meta, omit: undefined } });
      readers.push([name, child.read ?? (() => value[name])]);
    }
    return {
      read: () => {
        const out = Object.fromEntries(readers.map(([n, r]) => [n, r()]));
        return optional && Object.values(out).every((v) => v == null || v === '') ? null : out;
      },
    };
  }

  // view
  if (req.value == null) return (el.append(h('span', { class: 'dv-muted' }, '—')), {});
  const box = h('div', { class: 'dv-record' });
  el.append(box);
  for (const [name, def] of entries) {
    if (empty(value[name])) continue;
    const cell = h('div', { class: 'dv-value' });
    box.append(fieldRow(h, name, def, cell));
    await ctx.render(cell, { kind: def.shape, value: value[name], mode: 'view', meta: req.meta, on: req.on });
  }
  if (!box.childElementCount) box.append(h('span', { class: 'dv-muted' }, '—'));
  return {};
}

function fieldRow(h: ViewerContext['h'], name: string, def: FieldDef, cell: HTMLElement): HTMLElement {
  return h('div', { class: 'dv-field' },
    h('span', { class: 'dv-label', title: def.description, 'data-help': def.description ? true : undefined }, name.replace(/_/g, ' ')),
    cell);
}

function mountInput(el: HTMLElement, base: string, value: unknown, optional: boolean, h: ViewerContext['h']): Mounted {
  if (base.startsWith('enum:')) {
    const values = base.slice(5).split('|');
    const sel = h('select', { class: 'dv-input' }, ...(optional ? [''] : []).concat(values).map((v) => h('option', { value: v }, v || '—'))) as HTMLSelectElement;
    sel.value = value == null ? (optional ? '' : values[0]) : String(value);
    el.append(sel);
    return { read: () => (sel.value === '' ? null : sel.value) };
  }
  if (base === 'bool') {
    const box = h('input', { type: 'checkbox', class: 'dv-check' }) as HTMLInputElement;
    box.checked = Boolean(value);
    el.append(box);
    return { read: () => box.checked };
  }
  const input = h('input', { class: 'dv-input' }) as HTMLInputElement;
  input.value = value == null ? '' : String(value);
  el.append(input);
  return { read: () => (input.value === '' ? (optional ? null : '') : coerceToKind(base, input.value)) };
}

function mountJson(el: HTMLElement, req: ViewRequest, ctx: ViewerContext, optional: boolean): Mounted {
  const ta = ctx.h('textarea', { class: 'dv-input dv-mono', rows: 3 }) as HTMLTextAreaElement;
  ta.value = req.value == null ? '' : JSON.stringify(req.value, null, 1);
  el.append(ta);
  return { read: () => (ta.value.trim() ? JSON.parse(ta.value) : optional ? null : req.value) };
}

/** The right answer (`value`; a list = several, any one counts) against what was answered (`other`). */
function mountCompare(el: HTMLElement, req: ViewRequest, ctx: ViewerContext): Mounted {
  const { h } = ctx;
  const golds = Array.isArray(req.value) && !Array.isArray(unwrap(req.kind).base) ? req.value : [req.value];
  for (const [i, gold] of golds.entries()) {
    const rows = goldDiff(gold, req.other);
    const table = h('table', { class: 'dv-table dv-compare' },
      h('tr', {}, h('th', { title: 'One part of the answer. (free): the right answer does not care about it.', 'data-help': true },
        golds.length > 1 ? `field (right answer ${i + 1} of ${golds.length})` : 'field'),
        h('th', {}, 'right answer'), h('th', {}, 'answered')));
    for (const r of rows)
      table.append(h('tr', { class: r.differs ? 'dv-differs' : '' }, h('td', { class: 'dv-mono' }, r.path),
        h('td', { class: 'dv-mono' }, r.gold == null ? h('span', { class: 'dv-muted' }, '(free)') : plain(r.gold)),
        h('td', { class: 'dv-mono' }, plain(r.answered))));
    el.append(h('div', { class: 'dv-scroll' }, table));
  }
  return {};
}

/** One example of a dataset kind: each slot drawn by its own kind; the right answer edited or compared. */
async function mountExample(el: HTMLElement, req: ViewRequest, form: KindForm, ctx: ViewerContext): Promise<Mounted> {
  const { h } = ctx;
  const mode = req.mode ?? 'view';
  const row = (req.value ?? {}) as Record<string, unknown>;
  const slots = datasetSlots(form);
  const out = slots.find((s) => s.slot === 'output');
  if (mode === 'line') {
    const input = slots.find((s) => s.slot === 'input');
    return input ? ctx.render(el, { kind: input.shape, value: row.input, mode: 'line', meta: req.meta }) : {};
  }
  let read: (() => unknown) | undefined;
  for (const s of slots) {
    const cell = h('div', { class: 'dv-value' });
    const title = { input: 'Asked', context: 'What it had to go on', output: 'The right answer' }[s.slot] ?? s.slot;
    el.append(h('section', { class: 'dv-slot' }, h('h4', {}, title), cell));
    if (s === out && mode === 'edit') read = (await ctx.render(cell, { kind: s.shape, value: row[s.key], mode: 'edit', meta: req.meta })).read;
    else if (s === out && mode === 'compare')
      await ctx.render(cell, { kind: s.shape, value: row[s.key], mode: 'compare', other: (req.other as Record<string, unknown> | undefined)?.output, meta: req.meta });
    else await ctx.render(cell, { kind: s.shape, value: row[s.key], mode: 'view', meta: req.meta, on: req.on });
  }
  if (out && row.output != null && mode === 'view') {
    const cell = h('div', { class: 'dv-value' });
    el.append(h('section', { class: 'dv-slot' }, h('h4', {}, 'What the run answered'), cell));
    await ctx.render(cell, { kind: out.shape, value: row.output, mode: 'view', meta: req.meta });
  }
  return { read };
}

async function mountCollection(el: HTMLElement, req: CollectionRequest, ctx: ViewerContext): Promise<Mounted> {
  const { h } = ctx;
  el.replaceChildren();
  const { base } = unwrap(req.kind);
  const form = typeof base === 'string' ? await ctx.kindForm(base) : null;
  const columns: { key: string; title: string; shape: Shape; help?: string }[] =
    form?.subkind === 'dataset'
      ? datasetSlots(form).map((s) => ({ key: s.key, title: s.slot === 'output' ? 'right answer' : s.slot, shape: s.shape }))
          .concat(form.slots?.output ? [{ key: 'output', title: 'answered', shape: form.slots.output }] : [])
      : Object.entries(fieldsOf(form, base) ?? {}).map(([k, d]) => ({ key: k, title: k.replace(/_/g, ' '), shape: d.shape, help: d.description }));
  const table = h('table', { class: 'dv-table' },
    h('tr', {}, h('th', { class: 'dv-n' }, '#'), ...(columns.length ? columns : [{ key: '', title: 'value' }]).map((c: any) =>
      h('th', { title: c.help, 'data-help': c.help ? true : undefined }, c.title))));
  // The rows go on screen at once; their cells fill in side by side (each one a viewer).
  el.append(h('div', { class: 'dv-scroll' }, table));
  const rows: HTMLElement[] = [];
  const cells: Promise<unknown>[] = [];
  for (const [i, item] of req.items.entries()) {
    const tr = h('tr', { class: `dv-pick${req.selected === i ? ' dv-on' : ''}`, onclick: () => req.on?.('select', i) }, h('td', { class: 'dv-n dv-muted' }, String(i + 1)));
    rows.push(tr);
    table.append(tr);
    if (!columns.length) tr.append(h('td', { class: 'dv-mono' }, plain(item)));
    for (const c of columns) {
      const td = h('td');
      tr.append(td);
      cells.push(ctx.render(td, { kind: c.shape, value: (item as Record<string, unknown> | null)?.[c.key], mode: 'line', meta: req.meta }));
    }
  }
  if (!req.items.length) table.append(h('tr', {}, h('td', { class: 'dv-muted', colspan: columns.length + 1 }, 'Nothing here.')));
  await Promise.all(cells);
  return { select: (index) => rows.forEach((tr, i) => tr.classList.toggle('dv-on', i === index)) };
}

export const genericSingle: SingleViewer = { mount: mountSingle };
export const genericCollection: CollectionViewer = { mount: mountCollection };

export const GENERIC_VIEWER_STYLES = `
.dv-muted { color: hsl(var(--muted-foreground)); } .dv-sep { color: hsl(var(--muted-foreground)); }
.dv-mono { font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap; word-break: break-word; margin: 0; }
.dv-record, .dv-form { display: grid; gap: .3rem; }
.dv-field { display: grid; grid-template-columns: minmax(7rem, 11rem) 1fr; gap: .6rem; align-items: start; }
.dv-label { font-size: 12px; color: hsl(var(--muted-foreground)); padding-top: .15rem; }
.dv-record .dv-record, .dv-form .dv-form { border-left: 2px solid hsl(var(--border)); padding-left: .6rem; }
.dv-record .dv-record .dv-field, .dv-form .dv-form .dv-field { grid-template-columns: minmax(3.5rem, 6rem) 1fr; }
.dv-tag { display: inline-block; padding: 0 .45rem; border-radius: 6px; background: hsl(var(--muted)); font-size: 12px; }
.dv-chips { display: flex; flex-wrap: wrap; gap: .3rem; } .dv-chip { padding: 0 .45rem; border-radius: 6px; background: hsl(var(--muted)); font-size: 12px; }
.dv-input { font: inherit; padding: .2rem .4rem; border-radius: 6px; border: 1px solid hsl(var(--border)); background: hsl(var(--background)); color: inherit; width: 100%; box-sizing: border-box; }
.dv-scroll { overflow-x: auto; border: 1px solid hsl(var(--border)); border-radius: 10px; }
.dv-table { width: 100%; border-collapse: collapse; }
.dv-table th, .dv-table td { text-align: left; vertical-align: top; padding: .38rem .7rem; border-bottom: 1px solid hsl(var(--border)); }
.dv-table th { font-size: 12px; font-weight: 600; color: hsl(var(--muted-foreground)); background: hsl(var(--muted) / .45); }
.dv-table tr:last-child td { border-bottom: 0; }
.dv-n { width: 2.5rem; font-variant-numeric: tabular-nums; }
.dv-pick { cursor: pointer; } .dv-pick:hover td { background: hsl(var(--muted) / .45); } .dv-on td { background: hsl(var(--primary) / .12); }
.dv-differs td { box-shadow: inset 3px 0 0 hsl(8 72% 52%); }
.dv-slot { margin: 0 0 1rem; } .dv-slot > h4 { margin: 0 0 .35rem; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: hsl(var(--muted-foreground)); }
.dv-warn { display: inline-block; font-size: 11px; color: hsl(var(--muted-foreground)); border: 1px solid hsl(40 80% 50%); border-radius: 6px; padding: 0 .35rem; margin-bottom: .3rem; }
[data-help] { cursor: help; text-decoration: underline dotted hsl(var(--muted-foreground) / .6); text-underline-offset: 3px; }
`;

/** What the `data-viewer` asset ships for `*`: the generic viewer as a viewer module. */
export const genericViewers = { '*': { single: genericSingle, collection: genericCollection } };

// Data viewers: a kind is shown by the best viewer for it, nested values by THEIR kind's viewer, and
// the generic viewer covers every mode — all without a backend (the registry's seams are injected).
import { describe, expect, it, vi } from 'vitest';

import type { KindForm, ViewerChoice, ViewerModule } from '../../../ts_sdk/src/viewers/contract';
import { createViewerContext } from '../../../ts_sdk/src/viewers/registry';

const KINDS: Record<string, KindForm> = {
  'toy.outer': {
    kind: 'toy.outer',
    subkind: 'record',
    fields: {
      name: { shape: 'string', description: 'What it is called.' },
      size: { shape: '?int' },
      route: { shape: 'enum:quick|agentic' },
      inner: { shape: '?toy.inner' },
    },
  },
  'toy.inner': { kind: 'toy.inner', subkind: 'record', fields: { value: { shape: 'string' } } },
  'toy.dataset': { kind: 'toy.dataset', subkind: 'dataset', slots: { input: 'toy.inner', output: 'toy.outer' } },
};

const choice = (kind: string): ViewerChoice => ({ typeid: `micro_app-${kind}`, name: kind, title: `${kind} viewer`, why: 'kind', kind, endpoint: 'e', module: 'viewer.js' });

function host(modules: Record<string, ViewerModule | Error> = {}) {
  return createViewerContext({
    kindForm: async (k) => KINDS[k] ?? null,
    choices: async (k, shape) => (modules[k] && (modules[k] instanceof Error || (modules[k] as ViewerModule).viewers[k]?.[shape]) ? [choice(k)] : []),
    importModule: async (c) => {
      const m = modules[c.kind];
      if (m instanceof Error) throw m;
      return m as ViewerModule;
    },
  });
}

const el = () => document.createElement('div');

describe('nesting — each value is drawn by ITS kind\'s viewer', () => {
  it('a record field of another kind is handed to that kind\'s own viewer', async () => {
    const inner: ViewerModule = { viewers: { 'toy.inner': { single: { mount: (e, r) => ((e.textContent = `INNER:${(r.value as any).value}`), {}) } } } };
    const out = el();
    await host({ 'toy.inner': inner }).render(out, { kind: 'toy.outer', value: { name: 'a', route: 'quick', inner: { value: 'deep' } } });
    expect(out.textContent).toContain('INNER:deep');
    expect(out.textContent).toContain('name');
  });

  it('a viewer that fails to load falls back to the generic view, with a warning — never a blank', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = el();
    await host({ 'toy.inner': new Error('boom') }).render(out, { kind: 'toy.inner', value: { value: 'still shown' } });
    expect(out.querySelector('.dv-warn')).not.toBeNull();
    expect(out.textContent).toContain('still shown');
    warn.mockRestore();
  });

  it('a viewer that throws while mounting also falls back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken: ViewerModule = { viewers: { 'toy.inner': { single: { mount: () => { throw new Error('bad'); } } } } };
    const out = el();
    await host({ 'toy.inner': broken }).render(out, { kind: 'toy.inner', value: { value: 'x' } });
    expect(out.querySelector('.dv-warn')?.textContent).toContain('could not show this');
    warn.mockRestore();
  });
});

describe('the generic viewer, every mode', () => {
  it('edit reads back what was typed, typed by the kind', async () => {
    const out = el();
    const mounted = await host().render(out, { kind: 'toy.outer', value: { name: 'a', size: 1, route: 'quick' }, mode: 'edit' });
    const [name, size] = out.querySelectorAll('input');
    (name as HTMLInputElement).value = 'b';
    (size as HTMLInputElement).value = '7';
    (out.querySelector('select') as HTMLSelectElement).value = 'agentic';
    expect(mounted.read?.()).toEqual({ name: 'b', size: 7, route: 'agentic', inner: null });
  });

  it('edit leaves out what meta.omit names (a producer-only field)', async () => {
    const out = el();
    const mounted = await host().render(out, { kind: 'toy.outer', value: { name: 'a', route: 'quick' }, mode: 'edit', meta: { omit: ['size', 'inner'] } });
    expect(mounted.read?.()).toEqual({ name: 'a', route: 'quick' });
  });

  it('compare marks only the parts that differ; what the right answer leaves unset is free', async () => {
    const out = el();
    await host().render(out, { kind: 'toy.outer', value: { name: 'a', route: 'quick' }, other: { name: 'b', route: 'quick', size: 3 }, mode: 'compare' });
    const differs = [...out.querySelectorAll('tr.dv-differs td:first-child')].map((td) => td.textContent);
    expect(differs).toEqual(['name']);
    expect(out.textContent).toContain('(free)');
  });

  it('line is one line of the first fields', async () => {
    const out = el();
    await host().render(out, { kind: 'toy.outer', value: { name: 'a', route: 'quick' }, mode: 'line' });
    expect(out.textContent).toBe('a · quick');
  });

  it('a dataset example is laid out by its slots, each by its kind', async () => {
    const out = el();
    await host().render(out, { kind: 'toy.dataset', value: { input: { value: 'asked this' }, ground_truth: { name: 'gold', route: 'quick' } } });
    expect([...out.querySelectorAll('.dv-slot > h4')].map((x) => x.textContent)).toEqual(['Asked', 'The right answer']);
    expect(out.textContent).toContain('asked this');
  });

  it('the generic collection is a table of lines; picking a row says which', async () => {
    const out = el();
    const on = vi.fn();
    await host().renderCollection(out, { kind: 'toy.inner', items: [{ value: 'one' }, { value: 'two' }], on });
    const rows = out.querySelectorAll('tr.dv-pick');
    expect(rows).toHaveLength(2);
    (rows[1] as HTMLElement).click();
    expect(on).toHaveBeenCalledWith('select', 1);
  });

  it('a collection moves its highlight in place — choosing an item never redraws the list', async () => {
    const out = el();
    const mounted = await host().renderCollection(out, { kind: 'toy.inner', items: [{ value: 'one' }, { value: 'two' }], selected: 0 });
    const first = out.querySelector('tr.dv-pick');
    mounted.select?.(1);
    expect([...out.querySelectorAll('tr.dv-pick')].map((r) => r.classList.contains('dv-on'))).toEqual([false, true]);
    expect(out.querySelector('tr.dv-pick')).toBe(first);
  });
});

// The smart navigator's viewers (a shipped asset, plain JS): imported straight from the asset folder
// and mounted through a real viewer context, so what they nest resolves exactly as in the app.
import { describe, expect, it } from 'vitest';

import type { KindForm, ViewerChoice, ViewerModule } from '../../../ts_sdk/src/viewers/contract';
import { createViewerContext } from '../../../ts_sdk/src/viewers/registry';
// @ts-expect-error -- a plain-JS asset module, typed by the viewer contract
import * as navigator from '../../../flow_sdk/system_projects/flowpad_assistant/agentic-assets/webapp/navigator-viewers/viewer.js';

const mod = navigator as unknown as ViewerModule;
const KINDS: Record<string, KindForm> = {
  'navigator.decision': {
    kind: 'navigator.decision',
    subkind: 'record',
    fields: {
      route: { shape: 'enum:quick|agentic' },
      target: { shape: '?navigator.target' },
      verb: { shape: '?enum:show|navigate' },
      confidence: { shape: '?float' },
    },
  },
  'navigator.target': { kind: 'navigator.target', subkind: 'record', fields: { kind: { shape: 'string' }, value: { shape: 'string' } } },
};

const ctx = createViewerContext({
  kindForm: async (k) => KINDS[k] ?? null,
  choices: async (kind, shape) =>
    (mod.viewers[kind]?.[shape] ? [{ typeid: 'micro_app-nv', name: 'navigator-viewers', title: 'nv', why: 'kind', kind, endpoint: 'e', module: 'viewer.js' } as ViewerChoice] : []),
  importModule: async () => mod,
});

const gold = { route: 'quick', target: { kind: 'view', value: 'assets/list/task' } };
const answered = { route: 'quick', target: { kind: 'view', value: 'tasks' }, verb: 'show', confidence: 1 };

describe('navigator viewers', () => {
  it('a decision in one line', async () => {
    const el = document.createElement('div');
    await ctx.render(el, { kind: 'navigator.decision', value: answered, mode: 'line' });
    expect(el.textContent).toBe('view · tasks');
  });

  it('compare names exactly the part that differs and outlines it on the answer', async () => {
    const el = document.createElement('div');
    await ctx.render(el, { kind: 'navigator.decision', value: gold, other: answered, mode: 'compare' });
    expect(el.querySelector('.nv-verdict')?.textContent).toBe('✗ Differs in target.value');
    expect([...el.querySelectorAll('.nv-bad')].map((x) => x.textContent)).toEqual(['tasks']);
  });

  it('several right answers: the closest one decides', async () => {
    const el = document.createElement('div');
    await ctx.render(el, { kind: 'navigator.decision', value: [{ route: 'agentic' }, { route: 'quick', target: { kind: 'view', value: 'tasks' } }], other: answered, mode: 'compare' });
    expect(el.querySelector('.nv-verdict')?.textContent).toBe('✓ Went to the right place');
  });

  it('labelling is the generic form without the producer-only confidence', async () => {
    const el = document.createElement('div');
    const mounted = await ctx.render(el, { kind: 'navigator.decision', value: answered, mode: 'edit' });
    expect(mounted.read?.()).toEqual({ route: 'quick', target: { kind: 'view', value: 'tasks' }, verb: 'show' });
  });

  it('an example is a story: what was typed and where, then the right answer — the request drawn by its own viewer', async () => {
    const el = document.createElement('div');
    const row = {
      input: { utterance: 'show my tasks', here: { view: 'home', address: '/dock/home', project: { typeid: 'project-x', title: 'flowpad-oss' } } },
      context: { candidates: [{ type: 'task', title: 'Fix the bar', typeid: 'task-1' }] },
      ground_truth: gold,
    };
    await ctx.render(el, { kind: 'navigator.dataset', value: row, mode: 'compare', other: { output: answered } });
    expect(el.querySelector('.nv-utter')?.textContent).toBe('show my tasks');
    expect([...el.querySelectorAll('.nv-crumb')].map((x) => x.textContent)).toEqual(['home', 'project flowpad-oss']);
    expect(el.querySelector('.nv-cand-title')?.textContent).toBe('Fix the bar');
    expect(el.querySelector('.nv-verdict')?.textContent).toBe('✗ Differs in target.value');
    expect(el.textContent).not.toContain('null');
  });

  it('a request typed nowhere known still reads in one line — no "null" leaks into the page', async () => {
    const el = document.createElement('div');
    await ctx.render(el, { kind: 'navigator.request', value: { utterance: 'go home' }, mode: 'line' });
    expect(el.textContent).toBe('go home');
  });
});

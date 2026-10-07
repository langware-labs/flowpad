// Flowpad's own viewers: the Flow context (where someone was), a decision request, a decision response.
import { describe, expect, it, vi } from 'vitest';

import type { KindForm, ViewerContext } from '../../../ts_sdk/src/viewers/contract';
import { contextTrail, flowViewers, rankOptions, visibleOptions } from '../../../ts_sdk/src/viewers/flow';
import { createViewerContext } from '../../../ts_sdk/src/viewers/registry';

const HERE = {
  page: 'desk',
  view: 'data-sources',
  address: '/dock/data-sources',
  project: { typeid: 'project-1', title: 'flowpad-oss', path: '/w/flowpad-oss' },
  entity: { typeid: 'data_source-2', title: 'gmail-work' },
};

function ctxWith(navigate?: (t: string) => void): ViewerContext {
  return createViewerContext({
    kindForm: async () => null as KindForm | null,
    choices: async (kind, shape) => ((flowViewers as any)[kind]?.[shape] ? [{ typeid: 'm', name: 'flow-viewers', title: 'fv', why: 'kind', kind, endpoint: 'e', module: 'v.js' }] : []),
    importModule: async () => ({ viewers: flowViewers }),
    navigate,
  });
}

describe('the Flow context', () => {
  it('reads as a trail, broadest first; the desk page is implied', () => {
    expect(contextTrail(HERE).map((c) => c.label)).toEqual(['data-sources', 'project flowpad-oss', 'open: gmail-work']);
    expect(contextTrail({ page: 'hub', view: 'home' }).map((c) => c.label)).toEqual(['hub', 'home']);
    expect(contextTrail(null)).toEqual([]);
  });

  it('an entity in it opens in Flowpad', async () => {
    const navigate = vi.fn();
    const el = document.createElement('div');
    await ctxWith(navigate).render(el, { kind: 'navigation.here', value: HERE });
    const links = [...el.querySelectorAll('button.fv-crumb')];
    expect(links.map((b) => b.textContent)).toEqual(['project flowpad-oss', 'open: gmail-work']);
    (links[1] as HTMLElement).click();
    expect(navigate).toHaveBeenCalledWith('data_source-2');
  });

  it('without a host nothing is a link', async () => {
    const el = document.createElement('div');
    await ctxWith().render(el, { kind: 'navigation.here', value: HERE });
    expect(el.querySelectorAll('button')).toHaveLength(0);
    expect(el.textContent).toContain('/dock/data-sources');
  });
});

describe('a decision response', () => {
  const probabilities = { 'view:tasks': 0.62, 'view:assets/list/task': 0.3, agentic: 0.07, 'view:home': 0.006, 'view:shell': 0.004 };

  it('ranks the options, names the pick and the runner-up, and the margin', () => {
    const r = rankOptions(probabilities, 'view:tasks');
    expect(r.ranked.map((o) => o.key)[0]).toBe('view:tasks');
    expect([r.pick?.key, r.runnerUp?.key]).toEqual(['view:tasks', 'view:assets/list/task']);
    expect(r.margin).toBeCloseTo(0.32);
  });

  it('shows the notable options and folds the negligible ones (the pick always shows)', () => {
    const { ranked } = rankOptions(probabilities);
    expect(visibleOptions(ranked).map((o) => o.key)).toEqual(['view:tasks', 'view:assets/list/task', 'agentic']);
    const pick = ranked.find((o) => o.key === 'view:shell');
    expect(visibleOptions(ranked, pick).map((o) => o.key)).toContain('view:shell');
  });

  it('a decision run reads options by their meaning, marks its own bar, and says whether the pick cleared it', async () => {
    const el = document.createElement('div');
    await ctxWith().render(el, {
      kind: 'decision.run',
      value: {
        request: { state: {}, questions: { target: { type: 'choice', instructions: 'pick', options: { 'view:tasks': "Screen 'Tasks'" } } } },
        response: { answers: { target: { type: 'choice', choice: 'view:tasks', confidence: 0.62, probabilities } }, model: 'jev', latency_ms: 300 },
        act_at: { target: 0.85 },
        state_kinds: {},
      },
    });
    expect(el.querySelector('.fv-pick-name')?.textContent).toBe("Screen 'Tasks'");
    expect(el.querySelector('.fv-headline')?.textContent).toContain('below the 85% bar');
    expect(el.querySelectorAll('.fv-bar-threshold').length).toBeGreaterThan(0);
    expect(el.querySelector('.fv-more')?.textContent).toBe('2 more options, each under 1%');
  });
});

describe('a decision request', () => {
  it('draws a state part by the kind the caller names, and lists every option', async () => {
    const el = document.createElement('div');
    await ctxWith().render(el, {
      kind: 'decision.spec',
      value: { state: { utterance: 'show my tasks', context: HERE }, questions: { target: { type: 'choice', instructions: 'pick', options: { a: 'A', b: 'B' } } } },
      meta: { state_kinds: { context: 'navigation.here' } },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(el.querySelector('.fv-crumbs')?.textContent).toContain('project flowpad-oss');
    expect(el.querySelectorAll('.fv-opt-key')).toHaveLength(2);
  });
});

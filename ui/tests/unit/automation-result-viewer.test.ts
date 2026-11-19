// The automation result viewer (a shipped asset, plain JS), mounted through a real viewer context.
import { describe, expect, it, vi } from 'vitest';

import type { ViewerChoice, ViewerModule } from '../../../ts_sdk/src/viewers/contract';
import { createViewerContext } from '../../../ts_sdk/src/viewers/registry';
// @ts-expect-error -- a plain-JS asset module, typed by the viewer contract
import * as result from '../../../flow_sdk/system_projects/flowpad_assistant/agentic-assets/webapp/automation-result-viewer/viewer.js';

const mod = result as unknown as ViewerModule;
const navigate = vi.fn();
const ctx = createViewerContext({
  navigate,
  kindForm: () => Promise.resolve(null),
  choices: (kind, shape) =>
    Promise.resolve(
      mod.viewers[kind]?.[shape]
        ? [{ typeid: 'micro_app-ar', name: 'automation-result-viewer', title: 'ar', why: 'kind', kind, endpoint: 'e', module: 'viewer.js' } as ViewerChoice]
        : [],
    ),
  importModule: () => Promise.resolve(mod),
});

describe('automation result viewer', () => {
  it('shows the status and the summary, folds the details, and opens the session', async () => {
    const el = document.createElement('div');
    const session = 'agentic_process-7fdc9435-e260-4d21-8bdd-9e4dccff8f33';
    await ctx.render(el, {
      kind: 'automation.result',
      value: { status: 'expired', summary: 'Ishay did not reply in 3 days.', details: [{ label: 'Waited until', value: '19 Nov 2026' }], session },
    });
    expect(el.querySelector('[data-testid="automation-result-card"]')?.getAttribute('data-status')).toBe('expired');
    expect(el.querySelector('[data-testid="automation-result-status"]')?.textContent).toBe('Expired');
    expect(el.textContent).toContain('Ishay did not reply in 3 days.');
    const details = el.querySelector<HTMLElement>('[data-testid="automation-result-details"]')!;
    expect(details.hidden).toBe(true);
    el.querySelector<HTMLElement>('[data-testid="automation-result-details-toggle"]')!.click();
    expect(details.hidden).toBe(false);
    expect(details.textContent).toContain('19 Nov 2026');
    el.querySelector<HTMLElement>('[data-testid="automation-result-session"]')!.click();
    expect(navigate).toHaveBeenCalledWith(session);
  });
});

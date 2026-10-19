// The diagnosis viewer (a shipped asset, plain JS), mounted through a real viewer context.
import { describe, expect, it } from 'vitest';

import type { ViewerChoice, ViewerModule } from '../../../ts_sdk/src/viewers/contract';
import { createViewerContext } from '../../../ts_sdk/src/viewers/registry';
// @ts-expect-error -- a plain-JS asset module, typed by the viewer contract
import * as diagnosis from '../../../flow_sdk/system_projects/flowpad_assistant/agentic-assets/webapp/diagnosis-viewer/viewer.js';

const mod = diagnosis as unknown as ViewerModule;
const ctx = createViewerContext({
  kindForm: async () => null,
  choices: async (kind, shape) =>
    mod.viewers[kind]?.[shape]
      ? [{ typeid: 'micro_app-dg', name: 'diagnosis-viewer', title: 'dg', why: 'kind', kind, endpoint: 'e', module: 'viewer.js' } as ViewerChoice]
      : [],
  importModule: async () => mod,
});

const found = {
  status: 'needs_action',
  title: 'The backend does not answer its health check',
  summary: 'The backend does not answer its health check; The hub is unreachable',
  symptoms: 'it broke',
  findings: [
    { id: 'A2', severity: 'error', title: 'The backend does not answer its health check', detail: 'Restart Flowpad.', evidence: 'http://127.0.0.1:9007/health/status' },
    { id: 'C6', severity: 'warning', title: 'The hub is unreachable' },
  ],
  environment: { os: 'macOS-15', app_version: '0.2.200', instance: 'dg-1', backend_port: 6001, reported_by: 'Dana <d@x.io>' },
  logs: [{ file: '/x/logs/server/7Oct2026_10_00_00.log', lines: ['INFO up', 'ERROR boom'] }],
  diagnose: 'flowpad',
  errors: [],
  elapsed_ms: 1400,
};

describe('diagnosis viewer', () => {
  it('shows the status, the findings, the machine and the logs it travelled with', async () => {
    const el = document.createElement('div');
    await ctx.render(el, { kind: 'diagnosis', value: found });
    expect(el.querySelector('[data-testid="diagnosis-status"]')?.textContent).toBe('Needs action');
    expect([...el.querySelectorAll('[data-testid="diagnosis-finding"]')].map((f) => f.querySelector('.dg-id')?.textContent)).toEqual(['A2', 'C6']);
    expect(el.textContent).toContain('dg-1 · :6001');
    expect(el.textContent).toContain('by flowpad · 1.4s');
    expect(el.querySelector('.dg-pre')?.textContent).toBe('INFO up\nERROR boom');
  });

  it('a partial diagnosis says what went wrong while diagnosing', async () => {
    const el = document.createElement('div');
    await ctx.render(el, {
      kind: 'diagnosis',
      value: { status: 'partial', title: 'Diagnosis incomplete', errors: ['mine did not finish within 300s'], environment: { os: 'Windows-11' } },
    });
    expect(el.querySelector('[data-testid="diagnosis-status"]')?.textContent).toBe('Incomplete diagnosis');
    expect(el.querySelector('[data-testid="diagnosis-error"]')?.textContent).toBe('mine did not finish within 300s');
    expect(el.textContent).toContain('Windows-11');
  });

  it('a list reads one row each and reports the one picked', async () => {
    const el = document.createElement('div');
    const picked: unknown[] = [];
    await ctx.renderCollection(el, { kind: 'diagnosis', items: [found, { status: 'ok', title: 'fine' }], on: (e, i) => picked.push([e, i]) });
    const rows = el.querySelectorAll('.dg-row');
    expect(rows).toHaveLength(2);
    (rows[1] as HTMLElement).click();
    expect(picked).toEqual([['select', 1]]);
  });
});

/**
 * The run-history URL grammar.
 *
 * These assertions are the contract two independent things depend on: the
 * backend's `SCOPES` map (same key names, forwarded untranslated) and the tab
 * system (options never enter `tabHash`, so a selected run must not mint a
 * second tab).
 */
import { describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

describe('forProcessRuns', () => {
  it('is named for the entity it lists, not for workflows', () => {
    // `workflow_runs` is unavailable: `workflow_run` is already a record type
    // and docs/glossary.md bans bare `Workflow*`.
    expect(ViewType.PROCESS_RUNS).toBe('process-runs');
  });

  it('puts everything in options so one tab serves every run', () => {
    const p = DockPointer.forProcessRuns({ run: 'p1', flow_id: 'f1' });
    expect(p.pointer).toBeUndefined();
    expect(p.options).toEqual({ run: 'p1', flow_id: 'f1' });
    expect(p.tabHash).toBe(DockPointer.forProcessRuns({ run: 'p2' }).tabHash);
  });

  it('round-trips scope and selection through the URL', () => {
    const url = DockPointer.forProcessRuns({ run: 'p1', agent: 'email-summarizer' }).toUrl();
    const back = DockPointer.fromUrl(url);
    expect(back.selectedRunId).toBe('p1');
    expect(back.processRunScope).toEqual({ agent: 'email-summarizer' });
  });

  it('drops empty scope keys rather than sending blanks to the backend', () => {
    expect(DockPointer.forProcessRuns({ flow_id: '', run: null }).options).toEqual({});
    expect(DockPointer.forProcessRuns().processRunScope).toEqual({});
  });
});

describe('forGraphWorkflow', () => {
  const FLOW = '96d8281b-6314-4ad5-8c0f-f26219fde45d';

  it('keys the tab on the flow, whatever is open inside it', () => {
    const canvas = DockPointer.forGraphWorkflow(FLOW);
    const runs = DockPointer.forGraphWorkflow(FLOW, { panel: 'runs', run: 'p1' });
    expect(canvas.pointer).toBe(`graph_workflow-${FLOW}`);
    expect(runs.pointer).toBe(canvas.pointer);
    expect(runs.tabHash).toBe(canvas.tabHash);
    expect(runs.options).toEqual({ panel: 'runs', run: 'p1' });
  });

  it('accepts a bare id or a serialized typeid', () => {
    expect(DockPointer.forGraphWorkflow(`graph_workflow-${FLOW}`).pointer).toBe(
      DockPointer.forGraphWorkflow(FLOW).pointer,
    );
  });

  it('falls back to the flow list with no id', () => {
    const p = DockPointer.forGraphWorkflow(null);
    expect(p.viewType).toBe(ViewType.GRAPH_WORKFLOWS);
    expect(p.pointer).toBeUndefined();
  });
});

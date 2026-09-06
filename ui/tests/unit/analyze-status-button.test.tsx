/**
 * AnalyzeStatusButton — what the button does when the wizard closes.
 *
 * The task's own fields belong to the AGENT: it patches `task.md` (status,
 * process_id, analysis paths) and indexes it. The button previously wrote
 * `analysis_path` too, on the theory that the agent skipped that bookkeeping —
 * it hadn't; a crashing indexer was rejecting it. Two writers for one field,
 * with the button holding a pre-run snapshot, is what wiped observed task.md
 * files clean, so the button no longer writes task fields at all.
 *
 * What it DOES own: opening the group report, and offering the Done flip the
 * agent is forbidden to make itself (`readyForDone` → confirm dialog).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';

const h = vi.hoisted(() => ({
  onResult: null as ((r: unknown) => void) | null,
  openArtifact: vi.fn(),
  confirmProps: null as { open: boolean; onConfirm: () => void } | null,
  refreshByTypeId: vi.fn(),
}));

// Capture the onResult the button wires up, so the test can fire a wizard result.
vi.mock('@src/components/wizard/WizardButton', () => ({
  WizardButton: (props: { onResult?: (r: unknown) => void }) => {
    h.onResult = props.onResult ?? null;
    return null;
  },
}));
vi.mock('@src/components/ui/confirm-dialog', () => ({
  ConfirmDialog: (props: { open: boolean; onConfirm: () => void }) => {
    h.confirmProps = props;
    return null;
  },
}));
vi.mock('@src/components/task-bar/task-utils', () => ({
  openArtifact: (...a: unknown[]) => h.openArtifact(...a),
  TaskStatus: { TO_DO: 'to_do', IN_PROGRESS: 'in_progress', DONE: 'done' },
}));
vi.mock('@src/hooks/use-adopt-analyze-process', () => ({ useAdoptAnalyzeProcess: () => null }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: {} }),
}));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sdk')>()),
  ActionInfo: class {},
  Task: class {},
  TaskKind: { STANDARD: 'standard', GROUP: 'group' },
  dataManager: {
    callAction: vi.fn().mockResolvedValue(undefined),
    refreshByTypeId: (...a: unknown[]) => h.refreshByTypeId(...a),
  },
}));

import { AnalyzeStatusButton } from '@src/components/assets/editor/task/AnalyzeStatusButton';

const REPORT = 'C:/Users/x/tasks/ex22a/references/analysis.html';

function makeTask(over: Record<string, unknown> = {}) {
  return {
    id: 't1',
    kind: 'standard',
    status: 'to_do',
    project_id: 'p1',
    asset_ref: 'C:/tasks/ex22a',
    analysis_path: undefined as string | undefined,
    typeId: { toString: () => 'task-t1' },
    save: vi.fn().mockResolvedValue(undefined),
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fireResult(task: unknown, result: unknown) {
  render(<AnalyzeStatusButton task={task as never} />);
  h.onResult?.(result);
}

beforeEach(() => {
  h.onResult = null;
  h.confirmProps = null;
  h.openArtifact.mockReset();
  h.refreshByTypeId.mockReset().mockResolvedValue(null);
});

describe('AnalyzeStatusButton — the task fields stay the agent’s', () => {
  it('never writes the task after a run', async () => {
    const task = makeTask();
    fireResult(task, { status: 'done', data: { analysisPath: REPORT, readyForDone: false } });
    await vi.waitFor(() => expect(h.confirmProps).not.toBeNull());
    expect(task.save).not.toHaveBeenCalled();
    expect(task.analysis_path).toBeUndefined();
  });

  it('opens the group report from the path the wizard returned', () => {
    const task = makeTask({ kind: 'group' });
    fireResult(task, { status: 'done', data: { analysisPath: REPORT } });
    expect(h.openArtifact).toHaveBeenCalledWith(REPORT, expect.anything());
    expect(task.save).not.toHaveBeenCalled();
  });

  it('ignores a non-done result', () => {
    const task = makeTask();
    fireResult(task, { status: 'error', data: null, errorStr: 'boom' });
    expect(h.refreshByTypeId).not.toHaveBeenCalled();
    expect(task.save).not.toHaveBeenCalled();
  });
});

describe('AnalyzeStatusButton — the Done confirm', () => {
  it('asks before marking Done when the agent reports readyForDone', async () => {
    const task = makeTask();
    fireResult(task, { status: 'done', data: { readyForDone: true } });
    await vi.waitFor(() => expect(h.confirmProps?.open).toBe(true));

    // Nothing is written until the user confirms.
    expect(task.status).toBe('to_do');
    h.confirmProps?.onConfirm();
    await vi.waitFor(() => expect(task.status).toBe('done'));
    expect(task.save).toHaveBeenCalledTimes(1);
  });

  it('never asks when the agent did not report readyForDone', async () => {
    const task = makeTask();
    fireResult(task, { status: 'done', data: { analysisPath: REPORT } });
    await vi.waitFor(() => expect(h.confirmProps).not.toBeNull());
    expect(h.confirmProps?.open).toBe(false);
    expect(h.refreshByTypeId).not.toHaveBeenCalled();
  });

  it('does not ask about a task that is already Done', async () => {
    const task = makeTask({ status: 'done' });
    fireResult(task, { status: 'done', data: { readyForDone: true } });
    await vi.waitFor(() => expect(h.refreshByTypeId).toHaveBeenCalled());
    expect(h.confirmProps?.open).toBe(false);
  });

  it('reads Done-ness off the FRESH status, not the stale snapshot', async () => {
    // The agent (or another machine) already closed this out mid-run.
    const stale = makeTask({ status: 'to_do' });
    h.refreshByTypeId.mockResolvedValue(makeTask({ status: 'done' }));
    fireResult(stale, { status: 'done', data: { readyForDone: true } });
    await vi.waitFor(() => expect(h.refreshByTypeId).toHaveBeenCalledWith(stale.typeId));
    expect(h.confirmProps?.open).toBe(false);
  });

  it('marks Done on the FRESH entity, never the pre-run snapshot', async () => {
    const stale = makeTask();
    const fresh = makeTask({ status: 'in_progress' });
    h.refreshByTypeId.mockResolvedValue(fresh);

    fireResult(stale, { status: 'done', data: { readyForDone: true } });
    await vi.waitFor(() => expect(h.confirmProps?.open).toBe(true));
    h.confirmProps?.onConfirm();

    await vi.waitFor(() => expect(fresh.save).toHaveBeenCalled());
    expect(fresh.status).toBe('done');
    expect(stale.save).not.toHaveBeenCalled();
  });

  it('survives a failing save without throwing', async () => {
    const task = makeTask({ save: vi.fn().mockRejectedValue(new Error('offline')) });
    fireResult(task, { status: 'done', data: { readyForDone: true } });
    await vi.waitFor(() => expect(h.confirmProps?.open).toBe(true));
    expect(() => h.confirmProps?.onConfirm()).not.toThrow();
  });
});

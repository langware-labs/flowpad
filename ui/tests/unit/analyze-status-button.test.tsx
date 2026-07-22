/**
 * AnalyzeStatusButton — persisting the report path the wizard hands back.
 *
 * The Report button in TaskAssetEditor renders off `task.analysis_path`, but
 * the agent is the one asked to patch that field into the task's frontmatter
 * and `flow record index` it — bookkeeping it routinely skips. Observed runs
 * wrote a perfectly good `references/analysis.html`, returned its path in the
 * wizard result, and left `analysis_path` unset, so the report existed on disk
 * and was unreachable from the UI. The button has the path; it must save it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';

const h = vi.hoisted(() => ({
  onResult: null as ((r: unknown) => void) | null,
  openArtifact: vi.fn(),
}));

// Capture the onResult the button wires up, so the test can fire a wizard result.
vi.mock('@src/components/wizard/WizardButton', () => ({
  WizardButton: (props: { onResult?: (r: unknown) => void }) => {
    h.onResult = props.onResult ?? null;
    return null;
  },
}));
vi.mock('@src/components/task-bar/task-utils', () => ({
  openArtifact: (...a: unknown[]) => h.openArtifact(...a),
}));
vi.mock('@src/hooks/use-adopt-analyze-process', () => ({ useAdoptAnalyzeProcess: () => null }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: {} }),
}));

import { AnalyzeStatusButton } from '@src/components/assets/editor/task/AnalyzeStatusButton';

const REPORT = 'C:/Users/x/tasks/ex22a/references/analysis.html';

function makeTask(over: Record<string, unknown> = {}) {
  return {
    id: 't1',
    kind: 'standard',
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
  h.openArtifact.mockReset();
});

describe('AnalyzeStatusButton — report path persistence', () => {
  it('saves analysis_path when the wizard returns one the task lacks', () => {
    const task = makeTask();
    fireResult(task, { status: 'done', data: { analysisPath: REPORT } });
    expect(task.analysis_path).toBe(REPORT);
    expect(task.save).toHaveBeenCalledTimes(1);
  });

  it('does not re-save when the agent already patched the same path', () => {
    const task = makeTask({ analysis_path: REPORT });
    fireResult(task, { status: 'done', data: { analysisPath: REPORT } });
    expect(task.save).not.toHaveBeenCalled();
  });

  it('leaves the task alone when the wizard returns no path', () => {
    const task = makeTask();
    fireResult(task, { status: 'done', data: { readyForDone: true } });
    expect(task.analysis_path).toBeUndefined();
    expect(task.save).not.toHaveBeenCalled();
  });

  it('ignores a non-done result', () => {
    const task = makeTask();
    fireResult(task, { status: 'error', data: null, errorStr: 'boom' });
    expect(task.save).not.toHaveBeenCalled();
  });

  it('survives a failing save without throwing', () => {
    const task = makeTask({ save: vi.fn().mockRejectedValue(new Error('offline')) });
    expect(() => fireResult(task, { status: 'done', data: { analysisPath: REPORT } })).not.toThrow();
  });

  it('still opens the report directly for a group task', () => {
    const task = makeTask({ kind: 'group' });
    fireResult(task, { status: 'done', data: { analysisPath: REPORT } });
    expect(h.openArtifact).toHaveBeenCalledWith(REPORT, expect.anything());
    expect(task.analysis_path).toBe(REPORT);
  });
});

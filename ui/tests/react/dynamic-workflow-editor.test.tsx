/**
 * DynamicWorkflowAssetEditor: reads the script into an editable buffer, Save
 * writes via fsRef.write, and Run calls the entity's run() launcher. The header
 * and notifications are external surfaces — mocked so the test exercises only
 * this component's read/edit/save/run wiring (slick P7: <15-line-spirit, real
 * component, no business-logic mocks).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@src/components/assets/editor/AssetEditorHeader', () => ({
  AssetEditorHeader: ({ actions }: { actions?: React.ReactNode }) => <div>{actions}</div>,
}));
vi.mock('@src/notifications', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));
// The "runs of this entity" panel is the shared surface (Agent/Skill reuse it) —
// mock it to record the props this editor mounts it with.
const panelProps: Record<string, unknown> = {};
vi.mock('@src/components/entity-execution-panel/EntityExecutionPanel', () => ({
  EntityExecutionPanel: (props: Record<string, unknown>) => {
    Object.assign(panelProps, props);
    return <div data-testid="exec-panel" />;
  },
}));

import { ProcessKind } from '@sdk';
import { DynamicWorkflowAssetEditor } from '@src/components/assets/editor/dynamic-workflow/DynamicWorkflowAssetEditor';

function stubs(script: string) {
  const write = vi.fn().mockResolvedValue(undefined);
  const run = vi.fn().mockResolvedValue(undefined);
  const fsRef = { path: '/p/.claude/workflows/demo.js', read: vi.fn().mockResolvedValue(script), write } as never;
  const workflow = {
    id: 'dw1', name: 'demo', description: 'a demo', run,
    typeId: { toString: () => 'dynamic_workflow-dw1' },
  } as never;
  return { fsRef, workflow, write, run };
}

describe('DynamicWorkflowAssetEditor', () => {
  it('loads the script, saves edits, and runs', async () => {
    const { fsRef, workflow, write, run } = stubs('export const meta = { name: "demo" }');
    render(<DynamicWorkflowAssetEditor fsRef={fsRef} workflow={workflow} />);

    const ta = (await screen.findByTestId('dw-script')) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toContain('export const meta'));

    fireEvent.change(ta, { target: { value: 'return { ok: true }' } });
    fireEvent.click(screen.getByTestId('dw-save'));
    await waitFor(() => expect(write).toHaveBeenCalledWith('return { ok: true }'));

    fireEvent.click(screen.getByTestId('dw-run'));
    await waitFor(() => expect(run).toHaveBeenCalledWith(undefined, { ptyMode: true }));

    fireEvent.click(screen.getByTestId('dw-run-headless'));
    await waitFor(() => expect(run).toHaveBeenCalledWith(undefined, { ptyMode: false }));
  });

  it('mounts the shared runs panel keyed by the workflow typeId (Execution)', async () => {
    const { fsRef, workflow } = stubs('export const meta = {}');
    render(<DynamicWorkflowAssetEditor fsRef={fsRef} workflow={workflow} />);
    await screen.findByTestId('exec-panel');
    expect(panelProps.target).toBe('dynamic_workflow-dw1');
    expect(panelProps.processType).toBe(ProcessKind.Execution);
  });
});

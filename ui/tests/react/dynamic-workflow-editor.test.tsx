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

import { DynamicWorkflowAssetEditor } from '@src/components/assets/editor/dynamic-workflow/DynamicWorkflowAssetEditor';

function stubs(script: string) {
  const write = vi.fn().mockResolvedValue(undefined);
  const run = vi.fn().mockResolvedValue(undefined);
  const fsRef = { path: '/p/.claude/workflows/demo.js', read: vi.fn().mockResolvedValue(script), write } as never;
  const workflow = { id: 'dw1', name: 'demo', description: 'a demo', run } as never;
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
});

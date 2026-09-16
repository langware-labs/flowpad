import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { dataManager, FSRef } from '@sdk';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetEditorRouter } from '@src/components/assets/editor/AssetEditorRouter';

vi.mock('@src/components/agent-layout/agent-layout', () => ({
  useAgentContext: () => ({ computeNode: null, flow: null }),
}));
vi.mock('@src/hooks/use-entity-by-path', () => ({
  useEntityByPath: () => ({ entity: null, resolvedType: null, state: 'missing_asset' }),
}));

const queryClient = new QueryClient();

function View({ type, editor, folder }: { type: string; editor: string; folder: string }) {
  const pointer = `editor/${editor}/vfs/compute_node-@local${folder}`;
  return <QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[`/dock/desk/assets/${pointer}?readOnly=1&assetType=${type}`]}>
    <Routes><Route path="/dock/:page/:viewType/*" element={<AssetEditorRouter pointer={pointer} />} /></Routes>
  </MemoryRouter></QueryClientProvider>;
}

beforeEach(() => {
  vi.spyOn(FSRef.prototype, 'exists').mockResolvedValue(true);
  vi.spyOn(dataManager, 'getTypeInfo').mockImplementation((type) => ({
    shape: { kind: 'folder', main: type === 'task' ? 'task.md' : 'graph.json' },
  }) as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('read-only custom asset occurrences', () => {
  it('opens the clicked task file with no backing row or mutable task form', async () => {
    const read = vi.spyOn(FSRef.prototype, 'read').mockImplementation(function () {
      return Promise.resolve(`---\nid: 11111111-1111-4111-8111-111111111111\n---\n# ${this.path.includes('copy-two') ? 'Second task copy' : 'Primary task copy'}`);
    });
    const write = vi.spyOn(FSRef.prototype, 'write');
    const { rerender } = render(<View type="task" editor="task" folder="/project/tasks/copy-one" />);
    await screen.findByRole('heading', { name: 'Primary task copy' });
    rerender(<View type="task" editor="task" folder="/project/tasks/copy-two" />);
    await screen.findByRole('heading', { name: 'Second task copy' });
    expect(screen.getByTestId('readonly-asset-preview').textContent).not.toContain('11111111-1111-4111-8111-111111111111');
    expect(read.mock.contexts.map(ref => ref.path)).toContain('project/tasks/copy-two/task.md');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it('uses the registry main for a graph with no custom editor and has no mutation controls', async () => {
    const read = vi.spyOn(FSRef.prototype, 'read').mockResolvedValue('{"name":"clicked graph","nodes":[]}');
    const write = vi.spyOn(FSRef.prototype, 'write');
    render(<View type="graph_workflow" editor="code" folder="/project/agentic-assets/graph_workflow/copy-two" />);
    await waitFor(() => expect(screen.getByTestId('readonly-asset-code').textContent).toContain('clicked graph'));
    expect(read.mock.contexts[0].path).toBe('project/agentic-assets/graph_workflow/copy-two/graph.json');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /save|run|delete|publish/i })).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });
});

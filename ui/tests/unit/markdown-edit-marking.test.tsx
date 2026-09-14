import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { dataManager, FSRef, TypeId } from '@sdk';
import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

const MARKDOWN_ID = 'd5ee7e25-76c5-4f21-9b22-94cc5f3d65fc';

const milkdown = vi.hoisted(() => ({
  props: null as null | {
    onChange?: (content: string) => void;
    onUserEdit?: () => void;
    editorMode?: string;
  },
}));

vi.mock('@src/components/milkdown-editor/MilkdownEditor', () => ({
  MilkdownEditor: (props: typeof milkdown.props) => {
    milkdown.props = props;
    return <div data-testid="milkdown-stub" />;
  },
}));

vi.mock('@src/hooks/use-asset-revision-status', () => ({
  useAssetRevisionStatus: () => ({
    version: null,
    revisions: [],
    hasRepo: false,
    refresh: vi.fn(),
  }),
}));

class MemoryFSRef extends FSRef {
  override read(): Promise<string> {
    return Promise.resolve('# Original\n');
  }

  override write(): Promise<void> {
    return Promise.resolve();
  }
}

function renderEditor(editEntity?: { markEdit(): void }) {
  const fsRef = new MemoryFSRef(
    '/document.md',
    new TypeId('markdown', MARKDOWN_ID),
    'file',
    true,
  );
  return render(
    <MemoryRouter initialEntries={['/dock/assets/wiki/@local/Guide?editorMode=editor']}>
      <MarkdownEditor
        fsRef={fsRef}
        chatTarget={`markdown-${MARKDOWN_ID}`}
        editEntity={editEntity}
      />
    </MemoryRouter>,
  );
}

afterEach(() => {
  milkdown.props = null;
  cleanup();
  vi.restoreAllMocks();
});

describe('MarkdownEditor edit marking', () => {
  it('marks explicit user edits but not buffer synchronization', async () => {
    const markEdit = vi.fn();
    renderEditor({ markEdit });
    await waitFor(() => expect(milkdown.props).not.toBeNull());

    act(() => milkdown.props?.onChange?.('# External replacement\n'));
    expect(markEdit).not.toHaveBeenCalled();

    act(() => milkdown.props?.onUserEdit?.());
    expect(markEdit).toHaveBeenCalledOnce();
  });

  it('keeps entity-less markdown outside edit tracking', async () => {
    const managerMark = vi.spyOn(dataManager, 'markEdit');
    renderEditor();
    await waitFor(() => expect(milkdown.props).not.toBeNull());

    act(() => milkdown.props?.onUserEdit?.());
    expect(managerMark).not.toHaveBeenCalled();
  });
});


describe('MarkdownEditor read-only route', () => {
  it('ignores edit mode, hides mutation controls and refuses editor callbacks', async () => {
    const markEdit = vi.fn();
    const fsRef = new MemoryFSRef('/document.md', new TypeId('markdown', MARKDOWN_ID), 'file', true);
    render(<MemoryRouter initialEntries={['/dock/desk/assets/editor/markdown/typeid/markdown-' + MARKDOWN_ID + '?readOnly=1&editorMode=editor']}>
      <Routes><Route path="/dock/:page/:viewType/*" element={
        <MarkdownEditor fsRef={fsRef} chatTarget={null} editEntity={{markEdit}} onDelete={vi.fn()}
          headerLeading={<button>Publish</button>} headerExtras={() => <button>Mutate header</button>} />
      } /></Routes>
    </MemoryRouter>);
    await waitFor(() => expect(milkdown.props?.editorMode).toBe('view'));
    expect(screen.queryByTestId('editor-mode-chip-editor')).toBeNull();
    expect(screen.queryByTestId('markdown-editor-delete')).toBeNull();
    expect(screen.queryByText('Publish')).toBeNull();
    expect(screen.queryByText('Mutate header')).toBeNull();
    act(() => milkdown.props?.onUserEdit?.());
    expect(markEdit).not.toHaveBeenCalled();
  });
});

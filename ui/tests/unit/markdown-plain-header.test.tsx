import { cleanup, render, screen } from '@testing-library/react';
import { FSRef, TypeId } from '@sdk';
import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

const MARKDOWN_ID = 'd5ee7e25-76c5-4f21-9b22-94cc5f3d65fc';

class PendingFSRef extends FSRef {
  override async read(): Promise<string> {
    return new Promise(() => {});
  }
}

afterEach(cleanup);

describe('MarkdownEditor plain header', () => {
  it('does not mount full-editor mode controls while Hub content is loading', () => {
    const fsRef = new PendingFSRef(
      '/document.md',
      new TypeId('markdown', MARKDOWN_ID),
      'file',
      true,
    );

    render(
      <MemoryRouter initialEntries={['/dock/hub/assets/wiki/@hub/Guide']}>
        <MarkdownEditor
          fsRef={fsRef}
          chatTarget={`markdown-${MARKDOWN_ID}`}
          variant="plain"
          plainHeaderActions={() => <span>Hub actions</span>}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('plain-markdown-header')).toBeTruthy();
    expect(screen.getByText('Hub actions')).toBeTruthy();
    expect(screen.queryByTestId('asset-editor-header')).toBeNull();
    expect(screen.queryByTestId('editor-mode-chip-view')).toBeNull();
    expect(screen.queryByTestId('editor-mode-chip-editor')).toBeNull();
  });
});

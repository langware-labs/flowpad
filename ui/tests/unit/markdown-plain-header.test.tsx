import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FSRef, TypeId } from '@sdk';
import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

const MARKDOWN_ID = 'd5ee7e25-76c5-4f21-9b22-94cc5f3d65fc';

class PendingFSRef extends FSRef {
  override async read(): Promise<string> {
    return new Promise(() => {});
  }
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

afterEach(cleanup);

describe('MarkdownEditor chrome', () => {
  it('does not mount full-editor mode controls while a plain WikiTip is loading', () => {
    const fsRef = new PendingFSRef(
      '/document.md',
      new TypeId('markdown', MARKDOWN_ID),
      'file',
      true,
    );

    render(
      <MemoryRouter initialEntries={['/dock/assets/wiki/@local/Guide']}>
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

  it('keeps the normal editor mode controls mounted while content is loading', async () => {
    const fsRef = new PendingFSRef(
      '/document.md',
      new TypeId('markdown', MARKDOWN_ID),
      'file',
      true,
    );

    render(
      <MemoryRouter initialEntries={['/dock/hub/assets/wiki/@hub/Guide']}>
        <Routes>
          <Route
            path="/dock/:page/:viewType/*"
            element={(
              <>
                <MarkdownEditor
                  fsRef={fsRef}
                  chatTarget={`markdown-${MARKDOWN_ID}`}
                />
                <LocationProbe />
              </>
            )}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('asset-editor-header')).toBeTruthy();
    expect(screen.getByTestId('editor-mode-chip-view')).toBeTruthy();
    expect(screen.getByTestId('editor-mode-chip-editor')).toBeTruthy();
    expect(screen.queryByTestId('plain-markdown-header')).toBeNull();

    fireEvent.click(screen.getByTestId('editor-mode-chip-editor'));
    await waitFor(() =>
      expect(decodeURIComponent(screen.getByTestId('location').textContent ?? '')).toBe(
        '/dock/hub/assets/wiki/@hub/Guide?editorMode=editor',
      ),
    );
  });
});

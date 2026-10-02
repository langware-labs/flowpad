import { act, cleanup, render, waitFor } from '@testing-library/react';
import { FSRef, TypeId, type AssetDocument } from '@sdk';
import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { useSyncExternalStore } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it } from 'vitest';

class MemoryFSRef extends FSRef {
  /** Reads take a real round trip, as the backend's do — never the same tick. */
  override async readDocument(): Promise<AssetDocument> {
    await new Promise((arrive) => setTimeout(arrive, 0));
    return { body_ref: this.toJSON(), raw_text: '# Saved text\n', body: '# Saved text\n', fields: {}, body_start_line: 1, revision: 'r1' };
  }
}

afterEach(cleanup);

// After a save the entity store announces the update twice (updated_date, then the entity op),
// each bumping reloadKey from a sync-lane store. The editor must still show the file afterwards.
it('two back-to-back reloadKey bumps keep the document text in the editor', async () => {
  const fsRef = new MemoryFSRef('/doc.md', new TypeId('markdown', 'd5ee7e25-76c5-4f21-9b22-94cc5f3d65fc'), 'file', false);
  let key = 1; const listeners = new Set<() => void>();
  const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
  const bump = () => { key += 1; listeners.forEach((l) => l()); };
  function Host() {
    return <MarkdownEditor fsRef={fsRef} chatTarget={null} reloadKey={useSyncExternalStore(subscribe, () => key)} />;
  }
  const { container } = render(<MemoryRouter initialEntries={['/dock/assets/wiki/@local/Doc?editorMode=editor']}><Host /></MemoryRouter>);
  const text = () => container.querySelector('.ProseMirror')?.textContent;
  await waitFor(() => expect(text()).toBe('Saved text'));

  globalThis.IS_REACT_ACT_ENVIRONMENT = false; // the store notifies outside act, as the WS does
  bump(); await Promise.resolve(); bump();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(() => new Promise((settle) => setTimeout(settle, 300))); // re-read + Milkdown's 200ms emit debounce
  expect(text()).toBe('Saved text');
});

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMarkdownContent } from '@src/hooks/use-markdown-content';
import type { AssetDocument, DocumentPatch, DocumentRef } from '@sdk/fs/AssetDocument';
import { TypeId } from '@sdk/models/TypeId';

const watchers = vi.hoisted(() => new Map<string, () => void>());
vi.mock('@sdk/services/fsService', () => ({ fsManager: {
  watchFile: (_id: unknown, path: string, onChange: () => void) => { watchers.set(path, onChange); return () => watchers.delete(path); },
} }));

const initial = (): AssetDocument => ({ body_ref: { path: '/a/SKILL.md', type_id: 'compute_node-@local', read_only: false, ref_type: 'file' },
  body: 'Body\n', fields: { name: 'sample', metadata: { owner: 'team' } }, raw_text: '', body_start_line: 5, revision: 'first' });
function memoryDocument() {
  let stored = initial(); const writes: DocumentPatch[] = [];
  const ref: DocumentRef = { path: '/a/SKILL.md', readDocument: () => Promise.resolve(stored),
    updateDocument: (patch) => {
      if (patch.expected_revision !== stored.revision) return Promise.reject(Object.assign(new Error('stale_document'), { status: 409 }));
      writes.push(patch); stored = { ...stored, body: patch.body ?? stored.body,
        fields: { ...stored.fields, ...patch.set_fields }, revision: String(writes.length) };
      return Promise.resolve(stored);
    } };
  return { ref, writes, externalEdit: () => { stored = { ...stored, body: 'External', revision: 'external' }; } };
}
afterEach(() => vi.useRealTimers());
describe('document editor', () => {
  it('saves a body patch without serializing any frontmatter', async () => {
    const file = memoryDocument(); const { result } = renderHook(() => useMarkdownContent(file.ref, { autoSave: false }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.setBody('Edited'));
    await act(() => result.current.save());
    expect(file.writes).toEqual([{ expected_revision: 'first', body: 'Edited' }]);
    expect(result.current.dirty).toBe(false);
  });
  it('a conflict keeps the draft and blocks repeated saves until explicit reload', async () => {
    const file = memoryDocument(); const { result } = renderHook(() => useMarkdownContent(file.ref, { autoSave: false }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.setBody('My draft')); file.externalEdit();
    await act(() => result.current.save()); await act(() => result.current.save());
    expect(result.current.conflict).toBe(true); expect(result.current.body).toBe('My draft');
    expect(result.current.dirty).toBe(true); expect(file.writes).toHaveLength(0);
    await act(() => result.current.inspectCurrent());
    expect(result.current.currentDocument?.body).toBe('External');
    expect(result.current.body).toBe('My draft'); expect(result.current.conflict).toBe(true);
    await act(() => result.current.save()); expect(file.writes).toHaveLength(0);
    act(() => result.current.reload()); await waitFor(() => expect(result.current.body).toBe('External'));
    expect(result.current.conflict).toBe(false); expect(result.current.dirty).toBe(false);
  });
  it('a reload token refreshes in place — the loaded document never reads as loading', async () => {
    const file = memoryDocument(); const { result, rerender } = renderHook(({ key }) => useMarkdownContent(file.ref, { autoSave: false, reloadKey: key }), { initialProps: { key: 1 } });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const seen: boolean[] = [];
    file.externalEdit(); rerender({ key: 2 }); seen.push(result.current.isLoading);
    await waitFor(() => expect(result.current.body).toBe('External'));
    seen.push(result.current.isLoading);
    // An editor that shows a spinner while loading would unmount its children (an open dialog).
    expect(seen).toEqual([false, false]);
  });
  it('an external reload token preserves unsaved edits and their original revision', async () => {
    const file = memoryDocument(); const { result, rerender } = renderHook(({ key }) => useMarkdownContent(file.ref, { autoSave: false, reloadKey: key }), { initialProps: { key: 1 } });
    await waitFor(() => expect(result.current.isLoading).toBe(false)); act(() => result.current.setBody('My draft'));
    file.externalEdit(); rerender({ key: 2 }); await act(() => result.current.save());
    expect(result.current.conflict).toBe(true); expect(result.current.body).toBe('My draft');
  });
  it('watches the file only while shown and refreshes a clean buffer when it changes on disk', async () => {
    const file = memoryDocument(); const ref = { ...file.ref, watchId: new TypeId('compute_node-@local') };
    const { result, unmount } = renderHook(() => useMarkdownContent(ref, { autoSave: false }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    file.externalEdit(); act(() => watchers.get('/a/SKILL.md')?.());
    await waitFor(() => expect(result.current.body).toBe('External'));
    act(() => result.current.setBody('My draft')); act(() => watchers.get('/a/SKILL.md')?.());
    await act(() => Promise.resolve()); expect(result.current.body).toBe('My draft');
    unmount(); expect(watchers.has('/a/SKILL.md')).toBe(false);
  });
});

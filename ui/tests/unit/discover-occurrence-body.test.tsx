import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FSRef } from '@sdk';
import { fromDirectoryRow } from '@src/pages/discover-page/discover-model';
import { useDiscoverBody } from '@src/pages/discover-page/use-discover-body';
import type { DirectoryRow } from '@sdk/models/project-manifest';

afterEach(() => vi.restoreAllMocks());
it('reads the projected occurrence and changes authority even when its path is unchanged', async () => {
  const read = vi.spyOn(FSRef.prototype, 'read').mockImplementation(function (this: FSRef) { return Promise.resolve(this.toJSON().type_id); });
  const item = fromDirectoryRow({ typeid: 'skill-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', type: 'skill', name: 'sample',
    body_ref: { type_id: 'compute_node-@local', path: '/custom/entry.md' } } as DirectoryRow);
  const { result, rerender } = renderHook(({ current }) => useDiscoverBody(current, 'desk'), { initialProps: { current: item } });
  await waitFor(() => expect(result.current.body).toBe('compute_node-@local'));
  expect(result.current.fsRef?.path).toBe('/custom/entry.md');
  const next = { ...item, bodyRef: { type_id: 'project-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', path: '/custom/entry.md' } };
  rerender({ current: next });
  await waitFor(() => expect(result.current.body).toBe(next.bodyRef.type_id));
  expect(read).toHaveBeenCalledTimes(2);
});

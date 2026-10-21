import { renderHook, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Project, TypeId } from '@sdk';
import { useShareOwnerProject } from '@src/hooks/use-share-owner-project';
const read = vi.hoisted(() => vi.fn());
vi.mock('@src/hooks/entity-hooks', () => ({ useEntity: read }));
afterEach(() => {cleanup(); vi.clearAllMocks();});
it('reads the asset canonical owner and resolves that project', () => {
  const owner = new TypeId('markdown', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001');
  const project = new Project({id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002'});
  read.mockImplementation((ref) => ({data: ref?.type === Project.type ? project : {project_id: project.id}, isLoading: false}));
  const {result} = renderHook(() => useShareOwnerProject(owner, true));
  expect(result.current.project).toBe(project);
  expect(read.mock.calls[1][0].toString()).toBe(project.typeId.toString());
});
it('does not invent ownership for an unresolved asset', () => {
  read.mockReturnValue({data: null, isLoading: false});
  const {result} = renderHook(() => useShareOwnerProject(new TypeId('markdown', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'), true));
  expect(result.current).toEqual({project: null, loading: false});
  expect(read.mock.calls[1][0]).toBeNull();
});

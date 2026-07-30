/**
 * `useProjectTasks` feeds the rail's Tasks badge, which navigates to the
 * project-scoped `list/task` surface. The badge must count what that list
 * shows, so the hook carries the same predicate the list gets server-side:
 * a `project_id` match, NOT graph scope (a task isn't graph-scoped under its
 * project).
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const PROJECT_ID = 'dd682350-c185-52c9-a92b-d0667141b069';
const OTHER_PROJECT_ID = '65daac3b-f3e4-5b1a-af77-6d1451ec5bc4';

const project = vi.hoisted(() => ({ current: null as { id: string; typeId: string } | null }));
/** Every QueryRequest handed to useEntitiesQuery, in call order. */
const requests = vi.hoisted(() => [] as any[]);
/** The `enabled` option of the most recent call. */
const lastOptions = vi.hoisted(() => ({ current: undefined as any }));

vi.mock('@sdk/react/hooks', () => ({
  useProject: () => ({ project: project.current }),
  useEntitiesQuery: (request: any, options: any) => {
    requests.push(request);
    lastOptions.current = options;
    return { data: [], isLoading: false, error: null, refetch: vi.fn() };
  },
}));

import { useProjectTasks } from '@src/hooks/use-project-tasks';

/** QueryFilter normalizes `{project_id: X}` to the wire form the backend parses. */
const eqProject = (id: string) => ({ op: '$EQ', operands: ['project_id', id] });

describe('useProjectTasks scoping', () => {
  beforeEach(() => {
    requests.length = 0;
    lastOptions.current = undefined;
    project.current = { id: PROJECT_ID, typeId: `project-${PROJECT_ID}` };
  });

  it('matches the active project_id, and re-queries when the project changes', () => {
    const { rerender } = renderHook(() => useProjectTasks());

    expect(requests.at(-1).type).toBe('task');
    expect(requests.at(-1).query?.match).toMatchObject(eqProject(PROJECT_ID));
    expect(lastOptions.current?.enabled).toBe(true);

    project.current = { id: OTHER_PROJECT_ID, typeId: `project-${OTHER_PROJECT_ID}` };
    rerender();

    expect(requests.at(-1).query?.match).toMatchObject(eqProject(OTHER_PROJECT_ID));
  });

  it('is disabled — not silently unscoped — when no project is active', () => {
    project.current = null;
    renderHook(() => useProjectTasks());

    expect(lastOptions.current?.enabled).toBe(false);
  });
});

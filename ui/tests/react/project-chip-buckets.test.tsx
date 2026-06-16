/**
 * Behavioural lock for the project-menu chip (ProjectsCounterChip): it shows one
 * row per project that owns an open tab, across ALL tab kinds.
 *
 * Two regressions this guards:
 *   1. (historical) the chip collapsed to ONE bucket because the source was
 *      scoped to the current project — fixed by bucketing the UNSCOPED list.
 *   2. (this change) the chip counted only TERMINAL/agent tabs, so a project
 *      whose only open tab is content (markdown/skill/doc) vanished from the
 *      list — fixed by bucketing the raw `Tab` entities by `project_id`,
 *      independent of `target_type`. Global tabs (`project_id == null`) create
 *      no bucket.
 *
 * This test drives the REAL derivation (`useTabProjectBuckets` over the live
 * visible-tabs query). The only stand-ins are the HTTP boundary (`apiClient.get`,
 * same as skills-category-reactivity.test.tsx) and the ambient current-project
 * selection (`dataContext.project`) — neither is the logic under test; they
 * establish the input + precondition.
 */
import { ContextEntitiesEnum, dataContext, dataManager, Project, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTabProjectBuckets } from '@src/tabs/useTabs';

const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROJECT_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SHELL_A = 'c1111111-cccc-4ccc-8ccc-cccccccccccc';
const SHELL_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DOC_C = 'd1111111-dddd-4ddd-8ddd-dddddddddddd';
const TAB_A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TAB_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const TAB_C = 'f1111111-ffff-4fff-8fff-ffffffffffff';

/** A visible Tab row as the backend would serialize it, for any target type. */
function tabRow(id: string, targetType: string, targetId: string, projectId: string | null) {
  return {
    type: 'tab',
    id,
    target_type: targetType,
    target_id: targetId,
    project_id: projectId,
    visible: true,
    tab_order: 0,
    icon_key: targetType,
  };
}

describe('ProjectsCounterChip buckets — one chip per project across all projects', () => {
  let queryClient: QueryClient;

  beforeEach(async () => {
    await dataManager.clearCache();
    vi.restoreAllMocks();

    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    // Seed both Project entities so the bucket hook resolves each bucket 'live'
    // straight from cache (no per-project network).
    dataManager.updateEntityFromJson<Project>(
      new Project({ id: PROJECT_A, name: 'Project A' }) as never,
    );
    dataManager.updateEntityFromJson<Project>(
      new Project({ id: PROJECT_B, name: 'Project B' }) as never,
    );
    dataManager.updateEntityFromJson<Project>(
      new Project({ id: PROJECT_C, name: 'Project C' }) as never,
    );

    // HTTP boundary: the visible-tabs query returns three tabs across three
    // projects — two terminal tabs AND one CONTENT (markdown) tab whose project
    // (C) has no terminal at all. A global tab (project_id null) must be ignored.
    // Any other GET (entity loads/expansions) resolves to an empty list.
    vi.spyOn(apiClient, 'get').mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/tab')) {
        return [
          tabRow(TAB_A, 'shell', SHELL_A, PROJECT_A),
          tabRow(TAB_B, 'shell', SHELL_B, PROJECT_B),
          tabRow(TAB_C, 'markdown', DOC_C, PROJECT_C),
          tabRow('a0000000-0000-4000-8000-000000000000', 'settings', 'settings', null),
        ] as never;
      }
      return [] as never;
    });

    // Precondition: the user is currently in Project A's context. This is the
    // lever — with a current project set, useTerminalTabs() scopes to it. Set it
    // through the real context path (the same call the app makes on nav).
    await dataContext.setContextEntityTypeId(
      ContextEntitiesEnum.CurrentProjectTypeId,
      new TypeId(Project.type, PROJECT_A),
    );
  });

  afterEach(async () => {
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, null);
    vi.restoreAllMocks();
  });

  const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it('produces one bucket per project across all tab kinds (terminal + content), ignoring global tabs', async () => {
    const { result } = renderHook(() => useTabProjectBuckets(), { wrapper: Wrapper });

    // Let the visible-tabs query resolve and the buckets settle. Project C is
    // present even though its only open tab is a markdown (content) tab — the
    // bug fix. The global (project_id null) tab creates no bucket.
    await waitFor(() => {
      const ids = result.current.buckets.map((b) => b.projectId).sort();
      expect(ids).toEqual([PROJECT_A, PROJECT_B, PROJECT_C].sort());
    });

    expect(result.current.buckets).toHaveLength(3);
    const byId = new Map(result.current.buckets.map((b) => [b.projectId, b]));
    expect(byId.get(PROJECT_C)?.tabCount).toBe(1);
  });
});

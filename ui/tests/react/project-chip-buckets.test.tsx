/**
 * RCA capture (test mode): the project-menu chip (ProjectsCounterChip) shows
 * ONE chip even when terminal tabs span TWO different projects.
 *
 * Proven root cause this session:
 *   `useTerminalProjectBuckets()` (useTabs.ts) — the "which projects own which
 *   tabs" owner the chip renders from — sources its tabs via `useTerminalTabs()`
 *   called with NO argument. `useTerminalTabs(undefined)` defaults its scope to
 *   `dataContext.project?.id` (useTabs.ts:213) and `buildTerminalRows` then
 *   FILTERS the rows to that one project (useTabs.ts:202). So a tab belonging to
 *   any other project is dropped before bucketing → only the current project
 *   ever produces a bucket → exactly one chip.
 *
 * This test drives the REAL derivation (useTerminalProjectBuckets →
 * useTerminaltabs → buildTerminalRows → bucketing). The only stand-ins are the
 * HTTP boundary (`apiClient.get`, same as skills-category-reactivity.test.tsx)
 * and the ambient current-project selection (`dataContext.project`) — neither is
 * the logic under test; they establish the input + precondition.
 *
 * Expected behaviour: two tabs on two projects ⇒ TWO buckets ⇒ two chips.
 * Against current code this FAILS with buckets.length === 1 (the bug). It passes
 * once the bucket hook buckets the UNSCOPED tab list.
 */
import { ContextEntitiesEnum, dataContext, dataManager, Project, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTerminalProjectBuckets } from '@src/tabs/useTabs';

const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SHELL_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SHELL_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TAB_A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TAB_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

/** A visible, shell-target Tab row as the backend would serialize it. */
function tabRow(id: string, shellId: string, projectId: string) {
  return {
    type: 'tab',
    id,
    target_type: 'shell',
    target_id: shellId,
    project_id: projectId,
    visible: true,
    tab_order: 0,
    icon_key: 'shell',
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

    // HTTP boundary: the visible-tabs query returns two tabs on two projects.
    // Any other GET (entity loads/expansions) resolves to an empty list.
    vi.spyOn(apiClient, 'get').mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/tab')) {
        return [tabRow(TAB_A, SHELL_A, PROJECT_A), tabRow(TAB_B, SHELL_B, PROJECT_B)] as never;
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

  it('produces one bucket per project when tabs span two projects', async () => {
    const { result } = renderHook(() => useTerminalProjectBuckets(), { wrapper: Wrapper });

    // Let the visible-tabs query resolve and the buckets settle.
    await waitFor(() => {
      const ids = result.current.buckets.map((b) => b.projectId).sort();
      expect(ids).toEqual([PROJECT_A, PROJECT_B].sort());
    });

    expect(result.current.buckets).toHaveLength(2);
  });
});

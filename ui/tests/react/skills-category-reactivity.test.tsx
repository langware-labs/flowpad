import { ConnectionManager, dataManager, Project, Skill, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// SkillsCategory only navigates on click; stub the nav hook so the component
// mounts without a router. This is NOT the logic under test — the query
// reactivity is.
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));

import { SkillsCategory } from '@src/components/collaboration/sidebar/SkillsCategory';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MOUNT = '/tmp/test-project';
const SKILL_A_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SKILL_B_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function skillRow(id: string, name: string) {
  return {
    type: 'skill',
    id,
    name,
    asset_ref: `${MOUNT}/.claude/skills/${name.toLowerCase().replace(/\s+/g, '-')}/`,
    description: `${name} description`,
  };
}

describe('SkillsCategory — menu reactivity to skill CREATE data_op', () => {
  let queryClient: QueryClient;

  beforeEach(async () => {
    await dataManager.clearCache();
    vi.restoreAllMocks();

    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    // Seed the project so useEntity<Project> resolves its mount path from cache
    // (cache-first; no network).
    dataManager.updateEntityFromJson<Project>(
      new Project({ id: PROJECT_ID, name: 'Test Project', fs_storage_mount_path: MOUNT }) as never,
    );
  });

  afterEach(() => {
    cleanup();
  });

  const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it('shows a newly created skill after its CREATE data_op is broadcast', async () => {
    // First fetch → only skill A. Any later fetch (e.g. after invalidation) → A + B.
    const getSpy = vi.spyOn(apiClient, 'get');
    getSpy.mockResolvedValueOnce([skillRow(SKILL_A_ID, 'Skill A')] as never);
    getSpy.mockResolvedValue([skillRow(SKILL_A_ID, 'Skill A'), skillRow(SKILL_B_ID, 'Skill B')] as never);

    render(<SkillsCategory projectId={PROJECT_ID} />, { wrapper: Wrapper });

    // Initial menu state: A present, B absent.
    await vi.waitFor(() => expect(screen.getByText('Skill A')).toBeInTheDocument());
    expect(screen.queryByText('Skill B')).not.toBeInTheDocument();

    // Skill B is created elsewhere; the backend broadcasts a CREATE data_op.
    // This is exactly what `Entity.save()` emits over the WS (db_entity.py).
    const cm = ConnectionManager.getInstance();
    cm.emit(
      'on_data_op',
      new TypeId(Skill.type, SKILL_B_ID).toString(),
      'create',
      skillRow(SKILL_B_ID, 'Skill B') as never,
    );

    // The menu should now list Skill B. It does not, because SkillsCategory's
    // useQuery(['skills-include-system']) has no useEntityOps subscription to
    // invalidate on the create — so the cached list is never refetched.
    await vi.waitFor(() => expect(screen.getByText('Skill B')).toBeInTheDocument());
  });
});

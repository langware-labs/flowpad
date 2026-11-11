/**
 * The agent's Env/secrets hook reads the agent's project from the cache — it must never register an
 * id-only Project over the loaded one: every other reader of that project (the git setup wizard's
 * folder path, behind the New deployment checklist's "Add git") then read its fields as empty.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { dataManager, Project, TypeId, type Agent } from '@sdk';

import { useAgentSecrets } from '@src/components/assets/editor/agent-profile/use-agent-secrets';

describe('useAgentSecrets', () => {
  it('leaves the loaded project in the cache with its folder path', () => {
    const id = '7a1d3c55-0b6e-4f4e-9c1e-17a0de9f0017';
    const loaded = new Project({ id, name: 'demo', fs_storage_mount_path: '/w/demo' });
    const agent = { id: 'a1', project_id: id, requirements: [] } as unknown as Agent;

    const { result } = renderHook(() => useAgentSecrets(agent));

    const cached = dataManager.getByTypeIdFromCache<Project>(new TypeId(Project.type, id));
    expect(cached).toBe(loaded);
    expect(cached?.fs_storage_mount_path).toBe('/w/demo');
    expect(result.current.project).toBe(loaded);
  });
});

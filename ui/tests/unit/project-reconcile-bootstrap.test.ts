import { dataManager, Project } from '@sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Project.reconcileBootstrap', () => {
  it('calls the one semantic reconciliation action and returns its result', async () => {
    const project = new Project({
      id: '00000000-0000-4000-8000-000000000001',
      type: 'project',
      name: 'customer-project',
    } as Partial<Project>);
    const result = {
      target_project_id: project.id,
      content_projects: [],
      status: 'already_installed' as const,
      helpdesk_id: null,
      journey_ids: [],
      skill_ids: [],
      auto_launch_journey_id: null,
      failed: [],
    };
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue(result);

    await expect(project.reconcileBootstrap()).resolves.toEqual(result);

    const action = call.mock.calls[0][0];
    expect(action.name).toBe('reconcile-bootstrap');
    expect(action.bodyParameters).toEqual({});
  });
});

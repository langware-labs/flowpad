/**
 * The path from the backend's readiness to the footer's "Project setup required".
 *
 * Drives the real store (`@sdk/stores/project-readiness-store`) with the backend call stubbed at
 * `Project.setupRequirements` — the one seam between them — so what is pinned is the store's own
 * rules: the answer belongs to the project it was asked for, and a slower answer for a project the
 * user already left never shows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Project, type ProjectReadiness } from '@sdk/entities/project';
import {
  getProjectReadiness,
  recheckProjectReadiness,
  refreshProjectReadiness,
} from '@sdk/stores/project-readiness-store';
import { createProjectSetupRequiredWarning, WARNING_IDS } from '@sdk/models/UserWarning';

const readiness = (project_id: string, ready: boolean): ProjectReadiness => ({
  project_id,
  ready,
  to_do: ready ? [] : [{ kind: 'pack', name: 'google-cloud', title: '', vars: [], used_by: ['project'], note: '' }],
  gaps: [],
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('project readiness store', () => {
  it('holds the answer for the project it was asked for', async () => {
    vi.spyOn(Project, 'setupRequirements').mockResolvedValue(readiness('p1', false));

    await refreshProjectReadiness('p1');

    expect(getProjectReadiness()).toMatchObject({ project_id: 'p1', ready: false });
  });

  it('drops a slower answer for a project the user already switched away from', async () => {
    let answerSlow!: (r: ProjectReadiness) => void;
    vi.spyOn(Project, 'setupRequirements').mockImplementation((id) =>
      id === 'slow' ? new Promise((resolve) => (answerSlow = resolve)) : Promise.resolve(readiness(id, true)),
    );

    const slow = refreshProjectReadiness('slow');
    await refreshProjectReadiness('fast');
    answerSlow(readiness('slow', false));
    await slow;

    expect(getProjectReadiness()).toMatchObject({ project_id: 'fast', ready: true });
  });

  it('re-checks the project last asked about', async () => {
    const ask = vi.spyOn(Project, 'setupRequirements').mockResolvedValue(readiness('p2', true));
    await refreshProjectReadiness('p2');

    await recheckProjectReadiness();

    expect(ask).toHaveBeenLastCalledWith('p2');
  });

  it('a project with no id clears the answer', async () => {
    await refreshProjectReadiness(null);
    expect(getProjectReadiness()).toBeNull();
  });
});

describe('the warning', () => {
  it('names the project and how many things are left, and is routed by its id', () => {
    const warning = createProjectSetupRequiredWarning('spora', 3);
    expect(warning.id).toBe(WARNING_IDS.PROJECT_SETUP_REQUIRED);
    expect(warning.message).toBe('Project setup required');
    expect(warning.description).toContain('spora: 3 things');
  });
});

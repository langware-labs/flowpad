/** Refresh must reconcile ownership when a workspace folder becomes its own project. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiClient, Project, Workspace } from '@sdk';
import { apiTestSetup, trackCreatedRows } from '../utils/test-utils';

describe('Project.refresh reconciles unchanged skill ownership', () => {
  const projects = trackCreatedRows(Project.type);
  const workspaces = trackCreatedRows(Workspace.type);
  let mount: string;
  beforeEach(async () => {
    await apiTestSetup();
    mount = fs.mkdtempSync(path.join(os.homedir(), 'e2etest-skill-owner-'));
  });
  afterEach(() => fs.rmSync(mount, { recursive: true, force: true }));

  async function skillIds(project: Project) {
    const result = await apiClient.get<{ results: { record_id: string }[] }>('/api/v1/search', {
      params: { record_type: 'skill', user: 'false', projects: project.id, top_level: 'true' },
    });
    return result!.results.map(row => row.record_id);
  }

  it('includes an unchanged skill after registering its folder as a project', async () => {
    const workspace = await new Workspace({ name: path.basename(mount), root_path: mount }).save([]);
    workspaces.created.push(workspace.id);
    const container = await new Project({ name: mount }).save([]);
    projects.created.push(container.id);
    const nested = path.join(mount, 'nested');
    const skill = path.join(nested, 'e2etest-unchanged-skill');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: e2etest-unchanged-skill\ndescription: Ownership regression\n---\n# Skill\n');
    await container.refresh(['skill']);
    const indexed = await skillIds(container);
    expect(indexed).toHaveLength(1);
    const content = fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8');

    const project = await new Project({ name: nested }).save([]);
    projects.created.push(project.id);
    await project.refresh(['skill']);
    expect(fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8')).toBe(content);
    expect(await skillIds(project), 'Refresh must repair ownership of an unchanged skill').toEqual(indexed);
  });
});

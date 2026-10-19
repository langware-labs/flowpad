/** Manual refresh must discover skills in a Documents project without prior background consent. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiClient, instancePreferences, PrefKey, Project } from '@sdk';
import { apiTestSetup, trackCreatedRows } from '../utils/test-utils';

describe('Project.refresh in a protected folder', () => {
  const { created } = trackCreatedRows(Project.type);
  let mount: string;
  beforeEach(async () => {
    await apiTestSetup(); // Includes the real ConnectionManager bootstrap.
    expect(instancePreferences.get(PrefKey.INDEX_FOLDER_DOCUMENTS)).toBe('ask');
    const documents = path.join(os.homedir(), 'Documents');
    fs.mkdirSync(documents, { recursive: true });
    mount = fs.mkdtempSync(path.join(documents, 'e2etest-refresh-skills-'));
  });
  afterEach(() => { if (mount) fs.rmSync(mount, { recursive: true, force: true }); });

  it.each([['selected types', ['skill']], ['all types by default', undefined]] as const)(
    'indexes a local skill when refreshing %s', async (_label, types) => {
      const project = await new Project({ name: mount }).save([]);
      created.push(project.id);
      const skill = path.join(mount, '.claude', 'skills', 'e2etest-refresh-skill');
      fs.mkdirSync(skill, { recursive: true });
      fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: e2etest-refresh-skill\ndescription: Refresh regression\n---\n# Skill\n');
      await project.refresh(types === undefined ? undefined : [...types]);
      const result = await apiClient.get<{ total: number }>('/api/v1/search', {
        params: { record_type: 'skill', user: 'false', projects: project.id, top_level: 'true' },
      });
      expect(result?.total, 'Manual refresh completed but project skill search is empty').toBe(1);
    },
  );
});

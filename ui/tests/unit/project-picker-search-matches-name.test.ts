import { describe, expect, it } from 'vitest';
import type { ProjectListItem } from '@sdk';
import { matchesProjectQuery } from '@src/components/open-project-component/open-project-component';

// A project's name is not its folder: "gtm-studio" lives in .../marketing.
const project = {
  id: 'p1',
  name: 'gtm-studio',
  encoded_name: '-Users-a-ws-marketing',
  cwd: '/Users/a/ws/marketing',
} as ProjectListItem;

describe('project picker search', () => {
  it('finds a project by its own name when the folder is named differently', () => {
    expect(matchesProjectQuery(project, 'gt')).toBe(true);
  });

  it('still finds it by folder name and misses an unrelated query', () => {
    expect(matchesProjectQuery(project, 'marketing')).toBe(true);
    expect(matchesProjectQuery(project, 'zzz')).toBe(false);
  });
});

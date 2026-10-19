import { describe, expect, it } from 'vitest';

import { EntityFactory, ProjectManifest } from '@sdk';

/**
 * The Home card reads the declared home page off the indexed `project_manifest` row.
 * The store DROPS a queried row whose type has no constructor — so without a registered
 * class every read came back empty and the card showed "Default home" after any reload.
 */
describe('the project manifest row', () => {
  it('has a constructor, so a query keeps its rows', () => {
    expect(EntityFactory.getEntityConstructor('project_manifest')).toBe(ProjectManifest);
  });

  it('carries the declared home page', () => {
    const row = EntityFactory.createEntity({
      type: 'project_manifest',
      id: '00000000-0000-4000-8000-0000000000aa',
      project_id: 'p1',
      home_page: 'micro_app-00000000-0000-4000-8000-000000000009',
    } as never) as ProjectManifest;
    expect(row.home_page).toBe('micro_app-00000000-0000-4000-8000-000000000009');
    expect(row.project_id).toBe('p1');
  });
});

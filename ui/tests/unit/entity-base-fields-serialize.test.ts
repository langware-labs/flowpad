/**
 * A per-type schema describes that type's OWN fields. The desk publishes each
 * type's fully-resolved schema, but the hub publishes only the SUBCLASS DELTA
 * (`project` → artifacts/helpdesk/shared_*_origins). `toJSON` skips anything
 * `isDbField` rejects, so under the hub's schema `name` looked like a non-db
 * field and was stripped from every project POST/PUT — a project created on the
 * hub came back nameless. The shared base columns are db fields regardless of
 * what the served schema happens to list.
 */
import { dataManager, Project } from '@sdk';
import { JSONSchemaParser } from '@sdk/FlowSync/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PROJECT_ID = '20000000-0000-4000-8000-000000000001';

/** The hub's project schema: subclass delta only — no `name`. */
const HUB_PROJECT_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', default: 'project' },
    artifacts: { type: 'array' },
    helpdesk: { type: 'object' },
    shared_context_origins: { type: 'object' },
    shared_secret_origins: { type: 'object' },
  },
};

describe('base wire fields survive a partial type schema', () => {
  let previous: JSONSchemaParser | undefined;

  beforeEach(async () => {
    await dataManager.clearCache();
    previous = dataManager.schemas['project'];
    dataManager.schemas['project'] = new JSONSchemaParser(HUB_PROJECT_SCHEMA as never);
  });

  afterEach(() => {
    if (previous) dataManager.schemas['project'] = previous;
    else delete dataManager.schemas['project'];
  });

  it('keeps `name` in toJSON even though the schema does not declare it', () => {
    const project = new Project({ id: PROJECT_ID, type: Project.type, name: 'Hub Alpha' } as never);

    expect(project.isDbField('name')).toBe(true);
    expect(project.toJSON()).toMatchObject({ id: PROJECT_ID, type: 'project', name: 'Hub Alpha' });
  });

  it('still drops a field that is neither a base column nor in the schema', () => {
    const project = new Project({ id: PROJECT_ID, type: Project.type } as never);
    (project as unknown as Record<string, unknown>).not_a_field = 'nope';

    expect(project.isDbField('not_a_field')).toBe(false);
    expect(project.toJSON().not_a_field).toBeUndefined();
  });

  it('hydrates last_edited_at updates without echoing them in full saves', () => {
    const project = new Project({
      id: PROJECT_ID,
      type: Project.type,
      name: 'Hub Alpha',
      last_edited_at: 100,
    } as never);

    expect(project.last_edited_at).toBe(100);
    expect(project.toJSON().last_edited_at).toBeUndefined();

    const updated = dataManager.updateEntityFromJson<Project>({
      id: PROJECT_ID,
      type: Project.type,
      last_edited_at: 200,
    });

    expect(updated).toBe(project);
    expect(project.last_edited_at).toBe(200);
    expect(project.name).toBe('Hub Alpha');
    expect(project.toJSON().last_edited_at).toBeUndefined();
  });
});

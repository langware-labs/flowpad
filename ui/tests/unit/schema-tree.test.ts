// The schema tree: the project is the dock's scope, the selection its pointer, and following a link
// lands where the tree unfolds.
import { describe, expect, it } from 'vitest';

import { Tab, topLevelTabsForProject, type SchemaNode } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { bareKind, pathAfterLink, usedBy, type SchemaRoot } from '@src/components/schema-tree/schema-tree-model';
import { parseSchemaTreePointer, schemaTreePointer } from '@src/components/schema-tree/schema-tree-pointer';

const NS = '--sales_desk--.';
const kind = (name: string, uses: [string, 'inside' | 'link'][] = []): SchemaNode => ({
  kind: NS + name,
  name,
  subkind: 'record',
  description: '',
  folder: `agentic-assets/data_schema/${name}`,
  fields: [],
  rules: [],
  uses: uses.map(([used, held]) => ({ kind: NS + used, held, project_id: 'p1' })),
  dataset: null,
});

const MODEL: SchemaRoot[] = [{
  id: 'p1',
  name: 'Sales Desk',
  folder: '/work/sales-desk',
  schemas: [kind('crm.lead', [['crm.item', 'inside']]), kind('crm.item'), kind('crm.persona', [['crm.lead', 'link']])],
  sources: [{ id: 's1', name: 'Gmail', provider: 'gmail' }],
}];
const PERSONA = `${NS}crm.persona`;
const ICP = `${NS}crm.lead`;
const PROJECT = '550e8400-e29b-41d4-a716-446655440000';

describe('the project is the scope, the selection the pointer', () => {
  it('a dock names its project as the scope and the kinds as the pointer', () => {
    const dock = DockPointer.forSchemaTree(PROJECT, [PERSONA, ICP]);
    expect(dock.scopeProjectId).toBe(PROJECT);
    expect(dock.pointer).toBe(`${PERSONA}/${ICP}`);
    expect(parseSchemaTreePointer(dock.pointer)).toEqual([PERSONA, ICP]);
  });

  it('survives the URL, and is one tab per project whatever is selected', () => {
    const dock = DockPointer.forSchemaTree(PROJECT, [PERSONA, ICP]);
    const back = DockPointer.fromUrl(dock.toUrl());
    expect(back.scopeProjectId).toBe(PROJECT);
    expect(parseSchemaTreePointer(back.pointer)).toEqual([PERSONA, ICP]);
    expect(dock.tabHash).toBe(DockPointer.forSchemaTree(PROJECT).tabHash);
    expect(dock.tabHash).not.toBe(DockPointer.forSchemaTree('6ba7b810-9dad-41d1-80b4-00c04fd430c8').tabHash);
  });

  it('the project itself has no pointer', () => {
    expect(schemaTreePointer([])).toBeUndefined();
    expect(parseSchemaTreePointer(undefined)).toEqual([]);
    expect(bareKind(ICP)).toBe('crm.lead');
    expect(bareKind('navigator.decision')).toBe('navigator.decision');
  });
});

describe('following a link', () => {
  it('lands under the selected kind when it names the target', () => {
    expect(pathAfterLink(MODEL, [PERSONA], ICP)).toEqual([PERSONA, ICP]);
  });

  it('lands on the kind itself when the selection does not name it', () => {
    expect(pathAfterLink(MODEL, [`${NS}crm.item`], PERSONA)).toEqual([PERSONA]);
    expect(pathAfterLink(MODEL, [], ICP)).toEqual([ICP]);
  });

  it('goes back up the path to a kind already on it, and stays put for a kind nobody shown defines', () => {
    expect(pathAfterLink(MODEL, [PERSONA, ICP], PERSONA)).toEqual([PERSONA]);
    expect(pathAfterLink(MODEL, [PERSONA], 'crm.nobody')).toEqual([PERSONA]);
  });

  it('knows who uses a kind', () => {
    expect(usedBy(MODEL, ICP).map((n) => n.name)).toEqual(['crm.persona']);
  });
});

// The tab's project comes from the dock's scope (`Tab.resolveDockTarget`, what the loader persists
// on the row), and the project's strip lists only its own tabs.
describe('the schema tab belongs to its project', () => {
  it("resolves the dock's project, so the project's strip lists the tab", async () => {
    const dock = DockPointer.forSchemaTree(PROJECT, [PERSONA]);
    const { projectId } = await Tab.resolveDockTarget(dock);
    expect(projectId).toBe(PROJECT);
    const tab = new Tab({ id: '6ba7b810-9dad-41d1-80b4-00c04fd430c8', pointer: dock.toJSON(), project_id: projectId } as never);
    expect(topLevelTabsForProject([tab], PROJECT)).toEqual([tab]);
  });
});

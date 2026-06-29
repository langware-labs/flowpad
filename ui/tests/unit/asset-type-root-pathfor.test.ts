/**
 * Unit tests for `assetTypeRoot(...).pathFor` — specifically the de-duplication
 * fix: when the active pointer is the type's OWN list view (`list/<type>`), the
 * sidebar root must NOT auto-expand and bulk-fetch up to `childrenPageSize`
 * children, because the right panel already lists those same entities. pathFor
 * returns an empty chain for list mode (no expansion → no duplicate `/search`),
 * while still returning the full [root, leaf] chain for a single-entity editor
 * pointer so deep-links still expand to the file.
 *
 * No mocks: pathFor for both modes is pure pointer math — it never calls
 * listChildren (the network path), so the test drives the real adapter directly.
 */
import { describe, expect, it } from 'vitest';
import { assetTypeRoot } from '@src/components/browseable-tree/adapters/assetTypeRoot';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import type { AssetTypeInfo } from '@src/hooks/use-asset-types';

const SKILL: AssetTypeInfo = {
  type_name: 'skill',
  label: 'Skills',
  icon: null,
  creatable: true,
  browseable_by: 'standard',
};

const deps = { indexType: async () => undefined };

describe('assetTypeRoot.pathFor — list-mode de-dup', () => {
  it('returns an empty chain for the type\'s own list pointer (no sidebar bulk-fetch)', async () => {
    const root = assetTypeRoot(SKILL, deps);
    const chain = await root.pathFor(new DockPointer(ViewType.ASSETS, 'list/skill'));
    expect(chain).toEqual([]);
  });

  it('still returns [root, leaf] for a single-entity editor pointer (deep-link expands)', async () => {
    const root = assetTypeRoot(SKILL, deps);
    const chain = await root.pathFor(
      new DockPointer(ViewType.ASSETS, 'editor/skill/vfs/compute_node-@local/Users/me/x/SKILL.md'),
    );
    expect(chain.length).toBe(2);
    expect(chain[0].id).toBe(root.id);
    expect(chain[1].hasChildren).toBe(false); // the file leaf
  });

  it('still owns its list pointer (root stays highlighted via ownsPointer, not expansion)', () => {
    const root = assetTypeRoot(SKILL, deps);
    expect(root.ownsPointer(new DockPointer(ViewType.ASSETS, 'list/skill'))).toBe(true);
    expect(root.ownsPointer(new DockPointer(ViewType.ASSETS, 'list/agent'))).toBe(false);
  });
});

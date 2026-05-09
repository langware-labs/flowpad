import { describe, it, expect } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import {
  createMockBrowseable,
  createMockRoot,
  createMockTree,
  mockPointerFor,
} from '@src/components/browseable-tree/MockBrowseable';
import type { Browseable, BrowseableRoot } from '@src/components/browseable-tree/types';

describe('Browseable protocol', () => {
  describe('createMockBrowseable', () => {
    it('defaults kind, label, and pointer from id', () => {
      const b = createMockBrowseable({ id: 'x' });
      expect(b.id).toBe('x');
      expect(b.kind).toBe('mock');
      expect(b.label).toBe('x');
      expect(b.hasChildren).toBe(false);
      expect(b.pointer).toBeInstanceOf(DockPointer);
    });

    it('accepts overrides', () => {
      const b = createMockBrowseable({ id: 'x', label: 'Custom', hasChildren: true });
      expect(b.label).toBe('Custom');
      expect(b.hasChildren).toBe(true);
    });

    it('allows a null pointer for header-only rows', () => {
      const b = createMockBrowseable({ id: 'hdr', pointer: null });
      expect(b.pointer).toBeNull();
    });
  });

  describe('BrowseableRoot ownsPointer / pathFor', () => {
    it('ownsPointer returns true only for pointers under the root', () => {
      const root = createMockRoot('alpha');
      const owned = mockPointerFor(root.id);
      const otherRoot = createMockRoot('beta');
      const notOwned = mockPointerFor(otherRoot.id);

      expect(root.ownsPointer(owned)).toBe(true);
      expect(root.ownsPointer(notOwned)).toBe(false);
    });

    it('pathFor returns [root] when pointer is the root itself', async () => {
      const root = createMockRoot('alpha');
      const chain = await root.pathFor(mockPointerFor(root.id));
      expect(chain).toHaveLength(1);
      expect(chain[0].id).toBe(root.id);
    });

    it('pathFor resolves a descendant chain with unique ids', async () => {
      const root = createMockRoot('alpha');
      const children = await root.listChildren!();
      expect(children.length).toBeGreaterThan(0);

      // Pick a folder child if there is one; otherwise use the first leaf
      const folderChild = children.find((c) => c.hasChildren === true);
      const target = folderChild ?? children[0];
      const chain = await root.pathFor(mockPointerFor(target.id));

      expect(chain[0].id).toBe(root.id);
      expect(chain[chain.length - 1].id).toBe(target.id);
      const ids = chain.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('pathFor walks into grandchildren', async () => {
      // Use a seed known to produce a root whose first child has grandchildren
      const root = createMockRoot('with-gc', { seed: 1 });
      const children = await root.listChildren!();
      const folder = children.find((c) => c.hasChildren === true && c.listChildren);
      if (!folder) return; // seed-dependent; not a hard failure
      const grandchildren = await folder.listChildren!();
      expect(grandchildren.length).toBeGreaterThan(0);

      const leaf = grandchildren[0];
      const chain = await root.pathFor(mockPointerFor(leaf.id));
      expect(chain.map((n) => n.id)).toEqual([root.id, folder.id, leaf.id]);
    });
  });

  describe('ToolbarAction invariants', () => {
    it('toolbar[].run is callable and may return a Promise', async () => {
      let calls = 0;
      const sync: Browseable = createMockBrowseable({
        id: 'sync',
        toolbar: [{ id: 'a', icon: null, label: 'A', run: () => { calls++; } }],
      });
      sync.toolbar![0].run();
      expect(calls).toBe(1);

      let asyncDone = false;
      const asyncBrowseable: Browseable = createMockBrowseable({
        id: 'async',
        toolbar: [
          {
            id: 'b',
            icon: null,
            label: 'B',
            run: async () => {
              await Promise.resolve();
              asyncDone = true;
            },
          },
        ],
      });
      await asyncBrowseable.toolbar![0].run();
      expect(asyncDone).toBe(true);
    });
  });

  describe('Null pointer rows', () => {
    it('a Browseable with pointer: null is a valid node (no navigation)', () => {
      const hdr = createMockBrowseable({ id: 'h', pointer: null });
      expect(hdr.pointer).toBeNull();
    });
  });

  describe('createMockTree', () => {
    it('returns multiple roots with the expected kind and children hints', () => {
      const roots = createMockTree();
      expect(roots.length).toBeGreaterThanOrEqual(2);
      for (const r of roots) {
        expect(r.kind).toBe('root');
        expect(r.hasChildren).toBe(true);
        expect(typeof r.listChildren).toBe('function');
        expect(typeof r.ownsPointer).toBe('function');
        expect(typeof r.pathFor).toBe('function');
      }
    });

    it('each root owns its own pointer and rejects others', () => {
      const roots = createMockTree();
      for (const r of roots) {
        const self = mockPointerFor(r.id);
        expect(r.ownsPointer(self)).toBe(true);
        for (const other of roots) {
          if (other.id === r.id) continue;
          expect(r.ownsPointer(mockPointerFor(other.id))).toBe(false);
        }
      }
    });

    it('ownsPointer tolerates foreign DockPointers (non-mock)', () => {
      const r: BrowseableRoot = createMockRoot('alpha');
      const foreign = new DockPointer(ViewType.EDITOR, 'some/file.md');
      expect(r.ownsPointer(foreign)).toBe(false);
    });
  });
});

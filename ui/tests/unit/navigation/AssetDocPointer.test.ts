import { describe, expect, it } from 'vitest';
import { PageId, TypeId } from '@sdk';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import {
  AssetEditor,
  AssetMode,
  AssetPointerError,
  AssetRoutingMethod,
} from '@src/navigation/asset-doc-types';

const V4 = 'd864c29b-69fc-4b8d-b748-1526a83f598a'; // version nibble 4

describe('AssetDocPointer', () => {
  describe('round-trip parse ↔ toPointer', () => {
    it('vfs (markdown)', () => {
      const p = AssetDocPointer.forVfs(AssetEditor.MARKDOWN, '/Users/a/x.md');
      expect(p.toPointer()).toBe('editor/markdown/vfs/compute_node-@local/Users/a/x.md');
      const back = AssetDocPointer.parse(p.toPointer());
      expect(back.mode).toBe(AssetMode.EDITOR);
      expect(back.editor).toBe(AssetEditor.MARKDOWN);
      expect(back.method).toBe(AssetRoutingMethod.VFS);
      expect(back.value).toBe('compute_node-@local/Users/a/x.md');
    });

    it('vfs (code)', () => {
      const p = AssetDocPointer.forVfs(AssetEditor.CODE, '/Users/a/main.py');
      expect(p.toPointer()).toBe('editor/code/vfs/compute_node-@local/Users/a/main.py');
      expect(() => p.validate()).not.toThrow();
    });

    it('typeid (subagent)', () => {
      const p = AssetDocPointer.forTypeId(AssetEditor.SUBAGENT, new TypeId('subagent', V4));
      expect(p.toPointer()).toBe(`editor/subagent/typeid/subagent-${V4}`);
      const back = AssetDocPointer.parse(p.toPointer());
      expect(back.editor).toBe(AssetEditor.SUBAGENT);
      expect(back.method).toBe(AssetRoutingMethod.TYPEID);
      expect(back.value).toBe(`subagent-${V4}`);
    });

    it('forEntity prefers typeid', () => {
      const p = AssetDocPointer.forEntity({ type: 'skill', typeId: new TypeId('skill', V4) });
      expect(p.toPointer()).toBe(`editor/skill/typeid/skill-${V4}`);
    });

    it('wiki (default space)', () => {
      const p = AssetDocPointer.forWiki('My Doc');
      expect(p.toPointer()).toBe('wiki/@local/My Doc');
      const back = AssetDocPointer.parse(p.toPointer());
      expect(back.mode).toBe(AssetMode.WIKI);
      expect(back.space).toBe('@local');
      expect(back.wikiName).toBe('My Doc');
    });

    it('wiki (explicit space)', () => {
      const back = AssetDocPointer.parse('wiki/workspace-123/Some Note');
      expect(back.space).toBe('workspace-123');
      expect(back.wikiName).toBe('Some Note');
    });

    it('keeps a legacy wiki/<word> deep link in the local Wiki', () => {
      const back = AssetDocPointer.parse('wiki/Legacy Note');
      expect(back.space).toBe('@local');
      expect(back.wikiName).toBe('Legacy Note');
      expect(back.toPointer()).toBe('wiki/@local/Legacy Note');
    });

    it('builds the canonical Hub Wiki URL without changing the asset grammar', () => {
      const url = AssetDocPointer
        .forWiki('Quick start', V4)
        .toDockPointer()
        .withPage(PageId.HUB)
        .toUrl();
      expect(url).toBe(`/dock/hub/assets/wiki/${V4}/Quick%20start`);
    });
  });

  describe('validate', () => {
    it('accepts a valid typeid', () => {
      expect(() => AssetDocPointer.parse(`editor/markdown/typeid/markdown-${V4}`).validate()).not.toThrow();
    });
    it('rejects a non-typeid value in typeid mode', () => {
      expect(() => AssetDocPointer.parse('editor/markdown/typeid/not-a-typeid/x').validate()).toThrow(AssetPointerError);
    });
    it('rejects code + typeid (file-only)', () => {
      expect(() => AssetDocPointer.parse(`editor/code/typeid/markdown-${V4}`).validate()).toThrow(AssetPointerError);
    });
    it('rejects a vfs value with no compute-node root', () => {
      expect(() => AssetDocPointer.parse('editor/markdown/vfs/Users/a/x.md').validate()).toThrow(AssetPointerError);
    });
    it('rejects an unknown editor at parse', () => {
      expect(() => AssetDocPointer.parse('editor/bogus/vfs/compute_node-@local/x')).toThrow(AssetPointerError);
    });
    it('rejects an unknown routing method at parse', () => {
      expect(() => AssetDocPointer.parse('editor/markdown/bogus/x')).toThrow(AssetPointerError);
    });
  });

  describe('a vfs path value never reaches new TypeId (regression)', () => {
    it('parses a path containing dashes without throwing "Invalid typeId"', () => {
      // A real /Users path with dashes would parse as a TypeId under the old
      // implicit scheme; the explicit `vfs` segment routes it as a path instead.
      const ptr = 'editor/markdown/vfs/compute_node-@local/Users/me/some-dash-dir/my-file.md';
      const back = AssetDocPointer.parse(ptr);
      expect(back.method).toBe(AssetRoutingMethod.VFS);
      expect(() => back.validate()).not.toThrow();
      expect(back.value).toBe('compute_node-@local/Users/me/some-dash-dir/my-file.md');
    });
  });
});

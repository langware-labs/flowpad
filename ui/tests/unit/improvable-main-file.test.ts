import { describe, expect, it } from 'vitest';
import { improvableMainFile, type ImprovableTypeInfo } from '@src/components/asset-manager/asset-row-helpers';

// TypeInfo registry keyed by type name, mirroring the popover's assetTypeByName.
const registry = (entries: Record<string, ImprovableTypeInfo>) =>
  new Map<string, ImprovableTypeInfo>(Object.entries(entries));

describe('improvableMainFile — the "Improve" wand gate', () => {
  it('folder-shaped type WITH a main file → resolves to it (deck_template after fix)', () => {
    const types = registry({ deck_template: { shape: { kind: 'folder', main: 'template.json' } } });
    const d = { typeid: 'deck_template-74902ec4-9dd8-4dd3-8ae8-fb37b7a83b70', posix_path: '/proj/assets/deck-templates/git-basics' };
    expect(improvableMainFile(d, types)).toBe('template.json');
  });

  it('folder-shaped type WITHOUT a main file → null, so the wand is hidden (the bug)', () => {
    // deck_template BEFORE the TypeInfo fix: a bare folder shape with no main.
    const types = registry({ deck_template: { shape: { kind: 'folder', main: null } } });
    const d = { typeid: 'deck_template-74902ec4-9dd8-4dd3-8ae8-fb37b7a83b70', posix_path: '/proj/assets/deck-templates/git-basics' };
    expect(improvableMainFile(d, types)).toBeNull();
  });

  it('flat (non-folder) type → the path basename', () => {
    const types = registry({ markdown: { shape: { kind: 'file', ext: '.md' } } });
    const d = { typeid: 'markdown-abc', posix_path: '/proj/docs/notes.md' };
    expect(improvableMainFile(d, types)).toBe('notes.md');
  });

  it('empty / missing posix_path → null (nothing to improve)', () => {
    const types = registry({ markdown: {} });
    expect(improvableMainFile({ typeid: 'markdown-abc', posix_path: '' }, types)).toBeNull();
    expect(improvableMainFile({ typeid: 'markdown-abc', posix_path: null }, types)).toBeNull();
    expect(improvableMainFile({ typeid: 'markdown-abc' }, types)).toBeNull();
  });

  it('trailing slash on a folder path does not zero out a flat basename', () => {
    const types = registry({ markdown: { shape: { kind: 'file', ext: '.md' } } });
    const d = { typeid: 'markdown-abc', posix_path: '/proj/docs/notes.md/' };
    expect(improvableMainFile(d, types)).toBe('notes.md');
  });
});

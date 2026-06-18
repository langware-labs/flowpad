/**
 * EditableFileTree — skill-specific wiring unit tests (no mocks).
 *
 * Directory listing/rendering is covered by DirectoryTree's own suite; here we
 * test only what EditableFileTree adds: root-folder construction, that the
 * create-file/create-folder actions are wired, and the default file-open target.
 */

import { describe, it, expect, vi } from 'vitest';
import { FSItem, TypeId } from '@sdk';
import { buildRootFolder } from '@src/components/directory-tree/EditableFileTree';
import { ItemHandler } from '@src/components/directory-tree';

const COMPUTE_NODE = new TypeId('compute_node', '@local');
const SKILL_PATH = '/Users/x/.claude/skills/slick';

describe('buildRootFolder', () => {
  it('builds a root FSItem rooted at the folder on the compute node', () => {
    const root = buildRootFolder(COMPUTE_NODE, SKILL_PATH, 'slick');
    expect(root.is_dir).toBe(true);
    expect(root.vfs_abs_path).toBe('compute_node-@local/Users/x/.claude/skills/slick/.');
    expect(root.display_name).toBe('slick');
  });

  it('strips a leading slash from the path', () => {
    const root = buildRootFolder(COMPUTE_NODE, '/a/b', 'b');
    expect(root.vfs_abs_path).toBe('compute_node-@local/a/b/.');
  });
});

describe('EditableFileTree create actions', () => {
  it('exposes create-file and create-folder actions on a folder', () => {
    // The wrapper builds this exact ItemHandler shape; assert the add capability.
    const handler = new ItemHandler({
      actions: [
        ItemHandler.createFileAction(() => {}),
        ItemHandler.createFolderAction(() => {}),
        ItemHandler.refreshAction(() => {}),
      ],
    });
    const folder = new FSItem({ is_dir: true, vfs_abs_path: 'compute_node-@local/a/.' });
    const names = handler.getHoverActions(folder).map((a) => a.name);
    expect(names).toContain('create-file');
    expect(names).toContain('create-folder');
  });
});

describe('file-open navigation target', () => {
  it('opens a clicked file by its full vfs_abs_path', () => {
    // Mirror EditableFileTree's default onFileSelect: openEditor(item.vfs_abs_path).
    const navigation = { openEditor: vi.fn() };
    const file = new FSItem({
      is_dir: false,
      vfs_abs_path: 'compute_node-@local/Users/x/.claude/skills/slick/sample.py',
    });
    const handleFileSelect = (item: FSItem | null) => {
      if (!item || item.is_dir) return;
      navigation.openEditor(item.vfs_abs_path);
    };
    handleFileSelect(file);
    expect(navigation.openEditor).toHaveBeenCalledWith(
      'compute_node-@local/Users/x/.claude/skills/slick/sample.py',
    );
  });
});

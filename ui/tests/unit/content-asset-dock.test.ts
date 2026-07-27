import { Layout, TypeId } from '@sdk';
import { describe, expect, it } from 'vitest';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import {
  contentAssetTargetForDock,
  isContentAssetDock,
} from '@src/navigation/content-asset-dock';
import { DockPointer } from '@src/navigation/DockPointer';
import { AssetEditor } from '@src/navigation/asset-doc-types';
import { ViewType } from '@src/types/ViewType';

const ID = '30c05e11-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_ID = '66c05e11-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('content asset dock classification', () => {
  const typeIdDock = AssetDocPointer.forTypeId(
    AssetEditor.MARKDOWN,
    new TypeId('markdown', ID),
  ).toDockPointer();
  const vfsDock = AssetDocPointer.forVfs(
    AssetEditor.IMAGE,
    '/Users/a/project/image.png',
  ).toDockPointer();
  const wikiDock = DockPointer.forWiki('Design Notes');

  it.each([
    ['typeid asset', typeIdDock],
    ['file-only asset viewer', vfsDock],
    ['wiki', wikiDock],
    ['raw editor', DockPointer.forFile('/Users/a/project/main.ts')],
    [
      'project-rebased asset',
      DockPointer.rebaseAssetsOntoProject(typeIdDock, PROJECT_ID),
    ],
    [
      'project-rebased wiki',
      DockPointer.rebaseAssetsOntoProject(wikiDock, PROJECT_ID),
    ],
  ])('accepts %s', (_name, dock) => {
    expect(isContentAssetDock(dock)).toBe(true);
  });

  it.each([
    ['empty raw editor', new DockPointer(ViewType.EDITOR)],
    ['asset list', DockPointer.forAssetList('all')],
    ['asset folder', DockPointer.forAssetFolder('all', 'compute_node-@local')],
    ['project home', DockPointer.forAssetProjectHome()],
    ['project', DockPointer.forProject(PROJECT_ID)],
    [
      'graph targeting an asset',
      new DockPointer(ViewType.GRAPH, `markdown/${ID}`),
    ],
    [
      'lens targeting an asset',
      new DockPointer(ViewType.LENS, `markdown/item/${ID}`),
    ],
  ])('rejects %s', (_name, dock) => {
    expect(isContentAssetDock(dock)).toBe(false);
  });

  it('prefers a resolved entity TypeId as the process target', () => {
    const target = contentAssetTargetForDock(
      vfsDock,
      new TypeId('markdown', ID),
    );
    expect(target).toMatchObject({
      targetVfsPath: `markdown-${ID}`,
      typeId: `markdown-${ID}`,
    });
  });

  it('normalizes raw files to a compute-node VFS target', () => {
    const target = contentAssetTargetForDock(
      new DockPointer(
        ViewType.EDITOR,
        '/Users/a/project/main.ts',
        { line: '12', column: '3' },
        Layout.DOCK,
      ),
    );
    expect(target).toMatchObject({
      targetVfsPath: 'compute_node-@local/Users/a/project/main.ts',
      label: 'main.ts',
      path: '/Users/a/project/main.ts',
    });
  });
});

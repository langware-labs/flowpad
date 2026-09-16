import { Layout, TypeId } from '@sdk';
import { describe, expect, it } from 'vitest';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { contentAssetTargetForDock, isContentAssetDock, isPreviewAssetDock } from '@src/navigation/content-asset-dock';
import { DockPointer } from '@src/navigation/DockPointer';
import { AssetEditor } from '@src/navigation/asset-doc-types';
import { ViewType } from '@src/types/ViewType';

const ID = '30c05e11-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_ID = '66c05e11-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('content asset dock classification', () => {
  const typeIdDock = AssetDocPointer.forTypeId(AssetEditor.MARKDOWN, new TypeId('markdown', ID)).toDockPointer();
  const vfsDock = AssetDocPointer.forVfs(AssetEditor.IMAGE, '/Users/a/project/image.png').toDockPointer();
  const wikiDock = DockPointer.forWiki('Design Notes');

  it.each([
    ['typeid asset', typeIdDock],
    ['file-only asset viewer', vfsDock],
    ['wiki', wikiDock],
    ['raw editor', DockPointer.forFile('/Users/a/project/main.ts')],
    ['project-rebased asset', DockPointer.rebaseAssetsOntoProject(typeIdDock, PROJECT_ID)],
    ['project-rebased wiki', DockPointer.rebaseAssetsOntoProject(wikiDock, PROJECT_ID)],
  ])('accepts %s', (_name, dock) => {
    expect(isContentAssetDock(dock)).toBe(true);
  });

  it.each([
    ['empty raw editor', new DockPointer(ViewType.EDITOR)],
    ['asset list', DockPointer.forAssetList('all')],
    ['asset folder', DockPointer.forAssetFolder('all', 'compute_node-@local')],
    ['project home', DockPointer.forAssetProjectHome()],
    ['project', DockPointer.forProject(PROJECT_ID)],
    ['graph targeting an asset', new DockPointer(ViewType.GRAPH, `markdown/${ID}`)],
    ['lens targeting an asset', new DockPointer(ViewType.LENS, `markdown/item/${ID}`)],
    // A FILELESS editor: entity-backed, but there is no file (and for an LLM endpoint, no
    // local row either — it is a projection of hub state). Accepting it would hand the page
    // a work-context chat offering to edit a path that never existed, and take the assets
    // tree away to make room for it.
    [
      'fileless editor (llm endpoint)',
      AssetDocPointer.forTypeId(AssetEditor.LLM_ENDPOINT, new TypeId('llm_endpoint', ID)).toDockPointer(),
    ],
  ])('rejects %s', (_name, dock) => {
    expect(isContentAssetDock(dock)).toBe(false);
  });

  it('offers no process target for a fileless editor', () => {
    const dock = AssetDocPointer.forTypeId(AssetEditor.LLM_ENDPOINT, new TypeId('llm_endpoint', ID)).toDockPointer();
    expect(contentAssetTargetForDock(dock)).toBeNull();
  });

  it('prefers a resolved entity TypeId as the process target', () => {
    const target = contentAssetTargetForDock(vfsDock, new TypeId('markdown', ID));
    expect(target).toMatchObject({
      targetVfsPath: `markdown-${ID}`,
      typeId: `markdown-${ID}`,
    });
  });

  const htmlVfsDock = AssetDocPointer.forVfs(AssetEditor.HTML, '/Users/a/project/index.html').toDockPointer();

  it.each([
    // The FLOWPAD-2096 case: an un-indexed vfs file (no entity/typeid) shown
    // via `flow show`, e.g. an agent's `index.html` deliverable.
    ['html preview (vfs)', htmlVfsDock],
    // `vfsDock` is IMAGE — file-only AND in PREVIEW_EDITORS.
    ['image preview (vfs)', vfsDock],
    ['pdf preview (typeid)', AssetDocPointer.forTypeId(AssetEditor.PDF, new TypeId('pdf', ID)).toDockPointer()],
    ['project-rebased html preview', DockPointer.rebaseAssetsOntoProject(htmlVfsDock, PROJECT_ID)],
  ])('classifies %s as a preview asset dock', (_name, dock) => {
    expect(isPreviewAssetDock(dock)).toBe(true);
  });

  it.each([
    // A markdown editing surface — content asset, but not a passive preview.
    ['a markdown editor', typeIdDock],
    // File-only but excluded deliberately: raw source is worked ON, not shown.
    ['a raw code editor', DockPointer.forFile('/Users/a/project/main.ts')],
    // File-only, preview-shaped, but interactive (agent bridge) — excluded.
    [
      'an mcp app',
      AssetDocPointer.forVfs(AssetEditor.MCP_APP, '/Users/a/project/tool.mcp.html').toDockPointer(),
    ],
    ['a wiki page', wikiDock],
    ['a non-asset dock', DockPointer.forProject(PROJECT_ID)],
  ])('does not classify %s as a preview asset dock', (_name, dock) => {
    expect(isPreviewAssetDock(dock)).toBe(false);
  });

  it('normalizes raw files to a compute-node VFS target', () => {
    const target = contentAssetTargetForDock(
      new DockPointer(ViewType.EDITOR, '/Users/a/project/main.ts', { line: '12', column: '3' }, Layout.DOCK),
    );
    expect(target).toMatchObject({
      targetVfsPath: 'compute_node-@local/Users/a/project/main.ts',
      label: 'main.ts',
      path: '/Users/a/project/main.ts',
    });
  });
});

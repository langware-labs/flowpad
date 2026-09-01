import { describe, expect, it } from 'vitest';
import { TypeId } from '@sdk';
import { assetEditorOf } from '@src/navigation/asset-doc-pointer-grammar';
import { AssetEditor } from '@src/navigation/asset-doc-types';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const V4 = 'd864c29b-69fc-4b8d-b748-1526a83f598a';

/**
 * `assetEditorOf` / `DockPointer.assetEditor` answer WHICH EDITOR a route opens
 * without resolving the entity. Zone B swaps on that, so agent-vs-subagent and
 * the project-rebased form are the cases that matter.
 */
describe('assetEditorOf', () => {
  it('reads the editor off a vfs pointer', () => {
    expect(assetEditorOf('editor/agent/vfs/compute_node-@local/a/agent.md')).toBe(AssetEditor.AGENT);
  });

  it('reads the editor off a typeid pointer', () => {
    expect(assetEditorOf(`editor/agent/typeid/agent-${V4}`)).toBe(AssetEditor.AGENT);
  });

  it('distinguishes subagent from agent', () => {
    expect(assetEditorOf(`editor/subagent/typeid/subagent-${V4}`)).toBe(AssetEditor.SUBAGENT);
  });

  it('returns null for a wiki pointer', () => {
    expect(assetEditorOf('wiki/space/Word')).toBeNull();
  });

  it('returns null for a malformed or empty pointer', () => {
    expect(assetEditorOf('editor/not-an-editor/typeid/x')).toBeNull();
    expect(assetEditorOf('nonsense')).toBeNull();
    expect(assetEditorOf('')).toBeNull();
    expect(assetEditorOf(null)).toBeNull();
    expect(assetEditorOf(undefined)).toBeNull();
  });
});

describe('DockPointer.assetEditor', () => {
  it('resolves on a plain ASSETS dock', () => {
    const dock = new DockPointer(ViewType.ASSETS, `editor/agent/typeid/agent-${V4}`);
    expect(dock.assetEditor).toBe(AssetEditor.AGENT);
  });

  it('resolves through the project-rebased form', () => {
    const plain = new DockPointer(ViewType.ASSETS, `editor/agent/typeid/agent-${V4}`);
    const rebased = DockPointer.rebaseAssetsOntoProject(plain, 'project-id');
    expect(rebased.viewType).toBe(ViewType.PROJECT);
    expect(rebased.assetEditor).toBe(AssetEditor.AGENT);
  });

  it('is null for a non-asset dock and for a bare project dock', () => {
    expect(new DockPointer(ViewType.SHELL, `agentic_process-${V4}`).assetEditor).toBeNull();
    expect(new DockPointer(ViewType.PROJECT, 'project-id').assetEditor).toBeNull();
  });

  it('is null for an asset LIST dock, so the tree keeps the list view', () => {
    expect(DockPointer.forAssetList('skill').assetEditor).toBeNull();
  });

  it('reports the markdown editor for a doc route', () => {
    const dock = DockPointer.forAssetEditorByTypeId('markdown', new TypeId('markdown', V4));
    expect(dock.assetEditor).toBe(AssetEditor.MARKDOWN);
  });
});

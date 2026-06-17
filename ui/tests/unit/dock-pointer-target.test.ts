/**
 * DockPointer.targetTypeId / vfsPath — the pure-string projections the SDK
 * `Tab.getFromDockPointer` consumes to resolve a tab's target + project_id
 * (docs/tab-management.md). DockPointer stays a pure string manipulator: these
 * getters only parse the pointer (via the canonical AssetDocPointer grammar) —
 * no network, no DB.
 */
import { describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { ViewType } from '@src/types/ViewType';
import { AssetEditor } from '@sdk';

// Valid v4-shaped UUIDs (TypeId enforces the entity-id policy).
const U = (h: string) => `${h.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-000000000000`;

describe('DockPointer.targetTypeId', () => {
  it('extracts a shell target from a bare `<type>-<id>` pointer', () => {
    const tid = new DockPointer(ViewType.SHELL, `shell-${U('5e11')}`).targetTypeId;
    expect(tid?.type).toBe('shell');
    expect(tid?.id).toBe(U('5e11'));
  });

  it('extracts an asset target from the `…/typeid/<type>-<id>` form', () => {
    const p = new DockPointer(ViewType.ASSETS, `editor/markdown/typeid/markdown-${U('30c0')}`);
    expect(p.targetTypeId?.type).toBe('markdown');
    expect(p.targetTypeId?.id).toBe(U('30c0'));
  });

  it('extracts a project target from the viewType segment (bare id)', () => {
    const p = new DockPointer(ViewType.PROJECT, U('9b0a'));
    expect(p.targetTypeId?.type).toBe('project');
    expect(p.targetTypeId?.id).toBe(U('9b0a'));
  });

  it('is null for a vfs asset (a path is not a typeid)', () => {
    const dock = AssetDocPointer.forVfs(AssetEditor.MARKDOWN, '/Users/x/proj/docs/note.md').toDockPointer();
    expect(dock.targetTypeId).toBeNull();
  });

  it('is null for a target-less surface', () => {
    expect(new DockPointer(ViewType.SEARCH, 'q').targetTypeId).toBeNull();
  });
});

describe('DockPointer.vfsPath', () => {
  it('parses the path of a vfs asset dock', () => {
    const dock = AssetDocPointer.forVfs(AssetEditor.MARKDOWN, '/Users/x/proj/docs/note.md').toDockPointer();
    expect(dock.vfsPath).not.toBeNull();
  });

  it('is null for a typeid asset dock', () => {
    const p = new DockPointer(ViewType.ASSETS, `editor/markdown/typeid/markdown-${U('30c0')}`);
    expect(p.vfsPath).toBeNull();
  });

  it('is null for a non-asset dock', () => {
    expect(new DockPointer(ViewType.SHELL, `shell-${U('5e11')}`).vfsPath).toBeNull();
  });
});

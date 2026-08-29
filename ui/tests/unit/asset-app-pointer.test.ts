/**
 * `AssetEditor.APP` — an asset's editor app addressed through the asset-editor
 * grammar: the app name is an option, the pointer is entity-backed (typeid only).
 */
import { describe, expect, it } from 'vitest';
import { AssetEditor, isFileOnlyEditor, TypeId } from '@sdk';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { DockPointer } from '@src/navigation/DockPointer';

const typeId = new TypeId('data_source_spec', '11111111-2222-4333-8444-555555555555');

describe('AssetEditor.APP pointer', () => {
  it('serializes to editor/app/typeid/<type>-<id>?app=<name>&…', () => {
    const url = DockPointer.forAssetApp(typeId, 'spec', { source: 'abc' }).toUrl('');
    expect(url).toContain('/dock/assets/editor/app/typeid/data_source_spec-11111111-2222-4333-8444-555555555555');
    expect(url).toContain('app=spec');
    expect(url).toContain('source=abc');
  });

  it('parses back and validates as an entity-backed editor', () => {
    const ptr = AssetDocPointer.parse('editor/app/typeid/data_source_spec-11111111-2222-4333-8444-555555555555');
    expect(() => ptr.validate()).not.toThrow();
    expect(ptr.editor).toBe(AssetEditor.APP);
    expect(isFileOnlyEditor(AssetEditor.APP)).toBe(false);
  });

  it('has no vfs form', () => {
    const ptr = AssetDocPointer.parse('editor/app/vfs/compute_node-@local/some/path');
    expect(() => ptr.validate()).toThrow(/no vfs form/);
  });
});

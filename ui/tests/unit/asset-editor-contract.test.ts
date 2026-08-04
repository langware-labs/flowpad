// Asset-editor vocabulary — TypeScript side of the cross-language contract.
// tests/fixtures/asset_editor_contract.json is ALSO parsed by
// tests/unit/test_asset_editor_contract.py. The two suites pin one editor
// vocabulary, one type → editor mapping and one extension routing, so a
// backend deep link (`flow record url`) and a frontend dock pointer cannot
// drift apart. Change the fixture only with both suites in hand.
import { AssetEditor, EDITOR_TYPES, TYPE_TO_EDITOR, editorForType, isAssetEditor } from '@sdk';
import { describe, expect, it } from 'vitest';
import contract from '../../../tests/fixtures/asset_editor_contract.json';

describe('asset-editor contract (shared fixture)', () => {
  it('exposes the same editor vocabulary, in the same order', () => {
    expect(Object.values(AssetEditor)).toEqual(contract.editors);
  });

  it('maps each editor to the same record types', () => {
    const actual = Object.fromEntries(
      Object.entries(EDITOR_TYPES).map(([editor, types]) => [editor, types as string[]]),
    );
    expect(actual).toEqual(contract.editor_types);
  });

  /* The inversion is behaviour each language implements on its own, so the
   * derived map is pinned as well as the forward one. */
  it('derives the same type → editor inverse', () => {
    expect(TYPE_TO_EDITOR).toEqual(contract.type_to_editor);
  });

  it.each(contract.no_editor_types)('%s has no asset editor', (type) => {
    expect(editorForType(type)).toBeUndefined();
  });

  /* The URL grammar itself: the backend's `dock_url` is asserted against these
   * same rows in tests/unit/test_asset_editor_contract.py, so pinning the
   * shape here is what keeps a CLI-printed link and a clicked entity landing
   * in the same place. Extension routing is not part of this contract — it is
   * TS-only, covered by editor-for-path.test.ts. */
  it.each(contract.url_cases)('builds the dock pointer for $type', ({ type, typeid, pointer }) => {
    const editor = editorForType(type);
    expect(editor).toBeDefined();
    expect(`assets/editor/${editor}/typeid/${typeid}`).toBe(pointer);
  });

  it('accepts every contract editor as a valid editor name', () => {
    for (const editor of contract.editors) expect(isAssetEditor(editor)).toBe(true);
  });
});

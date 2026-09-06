/**
 * The type → editor mapping and the per-type extension sets come from the
 * backend type registry (`TypeInfo.editor` / `TypeInfo.shape`) when it is
 * bound; the static tables only answer for an unbound registry (hub bootstrap,
 * isolated unit tests).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  AssetEditor,
  bindAssetEditorRegistry,
  editorForPath,
  editorForType,
  mainFileForType,
  markdownExtensions,
  primaryTypeForEditor,
  type EditorTypeInfo,
} from '@sdk';
import { isMarkdownDocumentPath } from '@src/lib/markdown-path';
import { DockPointer } from '@src/navigation/DockPointer';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';

function bind(types: EditorTypeInfo[]) {
  const byName = new Map(types.map((t) => [t.type_name.toLowerCase(), t]));
  bindAssetEditorRegistry({ get: (type) => byName.get(type.toLowerCase()), all: () => types });
}

afterEach(() => bindAssetEditorRegistry(null));

describe('editorForType', () => {
  it('reads the registry editor when bound', () => {
    // A deliberately non-static answer proves the registry, not the table, spoke.
    bind([{ type_name: 'skill', editor: 'whiteboard', shape: { kind: 'folder', main: 'SKILL.md' } }]);
    expect(editorForType('skill')).toBe(AssetEditor.WHITEBOARD);
    // A type the static table never knew becomes openable once declared.
    bind([{ type_name: 'runbook', editor: 'markdown', shape: { kind: 'file', ext: '.md' } }]);
    expect(editorForType('runbook')).toBe(AssetEditor.MARKDOWN);
  });

  it('falls back to the static table when the registry is absent or silent', () => {
    bindAssetEditorRegistry(null);
    expect(editorForType('skill')).toBe(AssetEditor.SKILL);
    expect(editorForType('plan')).toBe(AssetEditor.MARKDOWN);
    // Bound, but no entry for the type → static answer.
    bind([{ type_name: 'task', editor: 'task' }]);
    expect(editorForType('skill')).toBe(AssetEditor.SKILL);
    // Bound with an editor name the client has no component for → static answer.
    bind([{ type_name: 'skill', editor: 'not-an-editor' }]);
    expect(editorForType('skill')).toBe(AssetEditor.SKILL);
  });

  it('DockPointer.forAssetEditor follows the registry editor', () => {
    bind([{ type_name: 'skill', editor: 'task' }]);
    const ptr = AssetDocPointer.parse(DockPointer.forAssetEditor('skill', '/Users/me/.claude/skills/x').pointer);
    expect(ptr.editor).toBe(AssetEditor.TASK);
  });
});

describe('primaryTypeForEditor', () => {
  it('is the registry inverse and undefined when unbound', () => {
    expect(primaryTypeForEditor('skill')).toBeUndefined();
    bind([{ type_name: 'skill', editor: 'skill' }, { type_name: 'plan', editor: 'markdown' }]);
    expect(primaryTypeForEditor('markdown')).toBe('plan');
    expect(primaryTypeForEditor('deck')).toBeUndefined();
  });
});

describe('extensions and main file', () => {
  it('markdown extensions derive from the registry shape (ext + also)', () => {
    expect(markdownExtensions()).toEqual(['md', 'markdown']);
    bind([{ type_name: 'markdown', editor: 'markdown', shape: { kind: 'file', ext: '.md', also: ['.mkd'] } }]);
    expect(markdownExtensions()).toEqual(['md', 'mkd']);
    expect(editorForPath('/tmp/a.mkd')).toBe(AssetEditor.MARKDOWN);
    expect(editorForPath('/tmp/a.markdown')).toBe(AssetEditor.CODE);
    expect(isMarkdownDocumentPath('/tmp/a.mkd')).toBe(true);
    // Display-only spellings stay, whatever the registry says.
    expect(isMarkdownDocumentPath('/tmp/a.md.out')).toBe(true);
  });

  it('mainFileForType reads shape.main and falls back to the literal', () => {
    expect(mainFileForType('skill', 'SKILL.md')).toBe('SKILL.md');
    bind([{ type_name: 'skill', editor: 'skill', shape: { kind: 'folder', main: 'skill.md' } }]);
    expect(mainFileForType('skill', 'SKILL.md')).toBe('skill.md');
    bind([{ type_name: 'markdown', editor: 'markdown', shape: { kind: 'file', ext: '.md' } }]);
    expect(mainFileForType('markdown')).toBeNull();
  });
});

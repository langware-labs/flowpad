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
import { AssetEditor, ComputeProviderType, parseWikiPointer, VFSPath } from '@sdk';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { vfsLocatorForComputeNode } from '@src/navigation/vfs-locator';

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

describe('DockPointer.resourceVfsPath', () => {
  const file = VFSPath.fromTypeId(LOCAL_COMPUTE_NODE, 'Users/x/proj/docs/note.md');

  it('uses one VFS identity across asset editor, Files, Explorer, and project-rebased routes', () => {
    const editor = DockPointer.forAssetEditor('markdown', file.absVfsPath);
    const files = DockPointer.forAssetFs(file);
    const explorer = DockPointer.forExplorer(file.absVfsPath);
    const projectFiles = DockPointer.rebaseAssetsOntoProject(files, U('9b0a'));

    expect(files.pointer).toBe(`fs/vfs/${file.absVfsPath}`);
    for (const dock of [editor, files, explorer, projectFiles]) {
      expect(dock.resourceVfsPath?.equals(file)).toBe(true);
    }
  });

  it('keeps vfsPath as a compatibility alias', () => {
    const dock = DockPointer.forAssetFs(file);
    expect(dock.vfsPath?.equals(dock.resourceVfsPath)).toBe(true);
  });

  it('rejects a relative VFS identity at the canonical builder', () => {
    expect(() => DockPointer.forAssetFs(VFSPath.parse('Users/x/note.md'))).toThrow(
      'Asset filesystem pointers require an absolute VFS path',
    );
  });
});

describe('vfsLocatorForComputeNode', () => {
  it('uses @local for bootstrap and provider-shaped local nodes', () => {
    expect(
      vfsLocatorForComputeNode({
        type: 'compute_node',
        id: U('10ca1'),
        name: '@local',
        uname: 'local',
      })?.equals(LOCAL_COMPUTE_NODE),
    ).toBe(true);
    expect(
      vfsLocatorForComputeNode({
        type: 'compute_node',
        id: U('10ca2'),
        node_provider_type: ComputeProviderType.LOCAL_MACHINE,
      })?.equals(LOCAL_COMPUTE_NODE),
    ).toBe(true);
  });

  it('retains a remote compute node UUID', () => {
    const id = U('a11ce');
    expect(
      vfsLocatorForComputeNode({
        type: 'compute_node',
        id,
        node_provider_type: ComputeProviderType.SSH,
      })?.toString(),
    ).toBe(`compute_node-${id}`);
  });
});

/**
 * The THIRD addressing form. A wiki route names its subject (a word) instead of
 * identifying it (typeid / path) so it survives a rename — which is exactly why
 * the other two getters return null here, and why anything that wants to say
 * where a wiki route points has to read this instead.
 */
describe('DockPointer.wikiRef', () => {
  it('splits the canonical `wiki/<space>/<word>` form', () => {
    const p = DockPointer.fromUrl('assets', `wiki/${U('w1k1')}/Duplicate assets`);
    expect(p.wikiRef).toEqual({ space: U('w1k1'), name: 'Duplicate assets', word: 'Duplicate assets' });
  });

  it('reads the `@local` alias as the space, not as part of the word', () => {
    expect(DockPointer.forWiki('Runtime environments').wikiRef).toEqual({
      space: '@local',
      name: 'Runtime environments',
      word: 'Runtime environments',
    });
  });

  it('treats the historical `wiki/<word>` deep link as @local', () => {
    expect(DockPointer.fromUrl('assets', 'wiki/Home').wikiRef).toEqual({ space: '@local', name: 'Home', word: 'Home' });
  });

  it('sees through the project-rebased form', () => {
    const p = DockPointer.fromUrl('project', `${U('9309')}/wiki/@local/Home`);
    expect(p.wikiRef).toEqual({ space: '@local', name: 'Home', word: 'Home' });
  });

  it('is null for every non-wiki pointer, and those stay null here', () => {
    const editor = new DockPointer(ViewType.ASSETS, `editor/markdown/typeid/markdown-${U('30c0')}`);
    expect(editor.wikiRef).toBeNull();
    expect(new DockPointer(ViewType.ASSETS, 'list/all').wikiRef).toBeNull();
    expect(new DockPointer(ViewType.SHELL, `shell-${U('5e11')}`).wikiRef).toBeNull();
    // And the converse: a wiki dock has neither of the other two forms. This is
    // the whole reason wikiRef exists.
    const wiki = DockPointer.forWiki('Duplicate assets', undefined, U('w1k1'));
    expect(wiki.targetTypeId).toBeNull();
    expect(wiki.resourceVfsPath).toBeNull();
  });
});

/**
 * `viewType === PROJECT` is not the same question as "addresses the project".
 * A project-REBASED asset route wears that viewType while addressing an asset,
 * and anything that conflates the two mislabels every one of them.
 */
describe('DockPointer.isProjectShell', () => {
  it('is true only for the bare project route', () => {
    expect(DockPointer.fromUrl('project', U('9309')).isProjectShell).toBe(true);
  });

  it('is false for every project-rebased asset route', () => {
    const rebased = [
      `${U('9309')}/wiki/@local/Home`,
      `${U('9309')}/editor/markdown/typeid/markdown-${U('30c0')}`,
      `${U('9309')}/list/all`,
    ];
    for (const p of rebased) {
      expect(DockPointer.fromUrl('project', p).isProjectShell).toBe(false);
    }
  });

  it('is false for docks that are not project routes at all', () => {
    expect(new DockPointer(ViewType.ASSETS, 'list/all').isProjectShell).toBe(false);
  });
});

/**
 * `wikiRef.word` mirrors the backend's `canonicalize_word`
 * (`flow_sdk/wiki/parser.py`) — what actually gets looked up, as opposed to
 * `name`, which is what the URL said and what the resolve store is keyed by.
 * Echoing `name` at the user names a page that was never opened.
 */
describe('DockPointer.wikiRef — raw name vs canonical word', () => {
  const word = (pointer: string) => DockPointer.fromUrl('assets', pointer).wikiRef;

  it('keeps only the first path segment', () => {
    expect(word('wiki/@local/Docs/Nested Child Page')).toEqual({
      space: '@local',
      name: 'Docs/Nested Child Page',
      word: 'Docs',
    });
  });

  it('strips a heading, an alias, a block ref and the .md suffix', () => {
    expect(word('wiki/@local/Page#a-heading')?.word).toBe('Page');
    expect(word('wiki/@local/Page|shown as this')?.word).toBe('Page');
    expect(word('wiki/@local/Page^block')?.word).toBe('Page');
    expect(word('wiki/@local/Page.md')?.word).toBe('Page');
  });

  it('drops . and .. segments the way the resolver does', () => {
    expect(word('wiki/@local/./Real Page')?.word).toBe('Real Page');
    expect(word('wiki/@local/../Real Page')?.word).toBe('Real Page');
  });

  it('leaves an ordinary word — and its spaces — alone', () => {
    expect(word('wiki/@local/Release Notes')?.word).toBe('Release Notes');
  });

  it('never yields an empty label, however degenerate the URL', () => {
    // The backend throws here; a URL is not ours to reject.
    expect(word('wiki/@local/#')?.word).toBe('#');
  });
});

/**
 * The wiki word rule is shared with the SDK's own tab naming, so a wiki URL
 * cannot name two different pages on screen at once. Pin the seam.
 */
describe('parseWikiPointer — the SDK-side entry to the same rule', () => {
  it('agrees with DockPointer.wikiRef on the shape the tab strip sees', () => {
    const pointer = 'wiki/@local/Docs/Nested Child Page';
    expect(parseWikiPointer(pointer)).toEqual(DockPointer.fromUrl('assets', pointer).wikiRef);
  });

  it('is null for a pointer that is not a wiki route', () => {
    expect(parseWikiPointer('list/all')).toBeNull();
    expect(parseWikiPointer('')).toBeNull();
    expect(parseWikiPointer(null)).toBeNull();
  });
});

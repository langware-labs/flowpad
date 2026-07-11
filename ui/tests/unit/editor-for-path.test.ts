/**
 * `editorForPath` is THE extension→viewer rule: every "open/show a raw file"
 * surface (openFile / explorer / chat attachments / the vibe display) routes
 * through it, so this table IS the display contract for raw files. Locks:
 * the `.mcp.html` precedence over `.html`, the media extension sets, case-
 * insensitivity, the CODE fallback — and the `dockPointerForFile` pointer
 * shapes built on top (ASSETS editor pointers for viewers, EDITOR for code).
 */
import { describe, expect, it } from 'vitest';
import { AssetEditor, editorForPath, EDITOR_TYPES, isFileOnlyEditor } from '@src/navigation/asset-doc-types';
import { dockPointerForFile } from '@src/navigation/local-file-pointer';
import { ViewType } from '@src/types/ViewType';

describe('editorForPath', () => {
  const cases: Array<[string, AssetEditor]> = [
    // mcp app — must win over the .html rule
    ['/tmp/form.mcp.html', AssetEditor.MCP_APP],
    ['/tmp/form.MCP.HTML', AssetEditor.MCP_APP],
    ['/tmp/form.mcp.htm', AssetEditor.MCP_APP],
    // html
    ['/tmp/crm.html', AssetEditor.HTML],
    ['/tmp/page.htm', AssetEditor.HTML],
    ['/tmp/PAGE.HTML', AssetEditor.HTML],
    // markdown
    ['/tmp/readme.md', AssetEditor.MARKDOWN],
    ['/tmp/readme.markdown', AssetEditor.MARKDOWN],
    // images (keep in sync with IMAGE_EXTENSIONS / isImagePath)
    ['/tmp/dog.png', AssetEditor.IMAGE],
    ['/tmp/dog.jpg', AssetEditor.IMAGE],
    ['/tmp/dog.jpeg', AssetEditor.IMAGE],
    ['/tmp/dog.gif', AssetEditor.IMAGE],
    ['/tmp/dog.webp', AssetEditor.IMAGE],
    ['/tmp/dog.svg', AssetEditor.IMAGE],
    ['/tmp/dog.avif', AssetEditor.IMAGE],
    ['/tmp/dog.bmp', AssetEditor.IMAGE],
    ['/tmp/dog.ico', AssetEditor.IMAGE],
    ['/tmp/DOG.PNG', AssetEditor.IMAGE],
    // video / audio
    ['/tmp/clip.mp4', AssetEditor.VIDEO],
    ['/tmp/clip.webm', AssetEditor.VIDEO],
    ['/tmp/clip.mov', AssetEditor.VIDEO],
    ['/tmp/song.mp3', AssetEditor.AUDIO],
    ['/tmp/song.wav', AssetEditor.AUDIO],
    ['/tmp/song.m4a', AssetEditor.AUDIO],
    ['/tmp/song.ogg', AssetEditor.AUDIO],
    // code fallback
    ['/tmp/main.ts', AssetEditor.CODE],
    ['/tmp/data.json', AssetEditor.CODE],
    ['/tmp/Makefile', AssetEditor.CODE],
    ['/tmp/noext', AssetEditor.CODE],
  ];

  it.each(cases)('%s → %s', (path, editor) => {
    expect(editorForPath(path)).toBe(editor);
  });

  it('new viewer editors are file-only (no record types)', () => {
    for (const e of [AssetEditor.HTML, AssetEditor.MCP_APP, AssetEditor.IMAGE, AssetEditor.VIDEO, AssetEditor.AUDIO]) {
      expect(EDITOR_TYPES[e]).toEqual([]);
      expect(isFileOnlyEditor(e)).toBe(true);
    }
    expect(isFileOnlyEditor(AssetEditor.MARKDOWN)).toBe(false);
  });
});

describe('dockPointerForFile', () => {
  it('routes an image to the assets image viewer pointer', () => {
    const ptr = dockPointerForFile('/tmp/dog.png');
    expect(ptr.viewType).toBe(ViewType.ASSETS);
    expect(ptr.pointer).toContain('editor/image/vfs/');
  });

  it('routes html to the assets html preview pointer', () => {
    const ptr = dockPointerForFile('/tmp/crm.html');
    expect(ptr.viewType).toBe(ViewType.ASSETS);
    expect(ptr.pointer).toContain('editor/html/vfs/');
  });

  it('keeps markdown on the markdown editor, including wide extensions', () => {
    expect(dockPointerForFile('/tmp/a.md').pointer).toContain('editor/markdown/vfs/');
    expect(dockPointerForFile('/tmp/a.mdx').pointer).toContain('editor/markdown/vfs/');
  });

  it('keeps code files on the code editor with line options', () => {
    const ptr = dockPointerForFile('/tmp/main.ts', { line: 3 });
    expect(ptr.viewType).toBe(ViewType.EDITOR);
  });
});

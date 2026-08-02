/**
 * `markdown_docs` is still a persisted process field and still the thing an
 * `.md` open path routes through — what went away is the RIBBON CHIP that read
 * it, replaced by the artifacts chip
 * (`terminal-bottom-ribbon-artifacts-chip.test.tsx`). The wire and routing
 * assertions below outlived that chip and are kept.
 */
import { cleanup } from '@testing-library/react';
import { AgenticProcess, dataManager } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

afterEach(() => cleanup());

describe('AgenticProcess — markdown.create wire update reaches the model', () => {
  beforeEach(async () => {
    await dataManager.clearCache();
  });
  afterEach(async () => {
    await dataManager.clearCache();
  });

  it('applies a backend markdown_docs update over the wire', () => {
    const process = new AgenticProcess({ id: '00000000-0000-4000-8000-0000000000aa' });
    expect(process.markdown_docs).toEqual([]);

    // Simulate the entity-update the backend save() broadcasts after writing
    // hello.md — the same deepAssign path the FlowSync store drives on every WS
    // entity-op. This is the real receive path, not a hand-set prop.
    dataManager.deepAssign(process, {
      markdown_docs: [{ path: '/repo/hello.md', name: 'hello.md', change: 'create' }],
    });
    expect(process.markdown_docs).toEqual([
      { path: '/repo/hello.md', name: 'hello.md', change: 'create' },
    ]);
  });

  it('a second write arrives as a grown list (deepAssign never corrupts order)', () => {
    const process = new AgenticProcess({ id: '00000000-0000-4000-8000-0000000000bb' });
    dataManager.deepAssign(process, {
      markdown_docs: [{ path: '/repo/hello.md', name: 'hello.md', change: 'create' }],
    });
    // Backend sends the full list (tail = latest) on the next save.
    dataManager.deepAssign(process, {
      markdown_docs: [
        { path: '/repo/hello.md', name: 'hello.md', change: 'create' },
        { path: '/repo/notes.md', name: 'notes.md', change: 'create' },
      ],
    });
    expect(process.markdown_docs.map((d) => d.name)).toEqual(['hello.md', 'notes.md']);
  });
});

describe('docs chip open target', () => {
  // Regression: the chip first used navigation.openDocs(path), which routes to
  // ViewType.DOCS and parses its arg as a typeId — crashing ("Invalid typeId")
  // on a raw absolute path (caught only in the browser). The correct opener is
  // the markdown asset editor addressed by VFS path, which renders the .md and
  // tolerates an absolute machine path.
  it('routes an absolute .md path to the markdown asset editor (vfs), not DOCS', () => {
    const dp = DockPointer.forAssetEditor('markdown', '/tmp/mdchip_hello.md');
    expect(dp.viewType).toBe(ViewType.ASSETS);
    expect(dp.viewType).not.toBe(ViewType.DOCS);
    expect(dp.pointer).toContain('editor/markdown/vfs');
    expect(dp.vfsPath).not.toBeNull(); // the file path resolved, no typeId crash
  });
});

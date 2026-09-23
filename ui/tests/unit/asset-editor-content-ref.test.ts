import { describe, expect, it } from 'vitest';

import { FSRef, TypeId, VFSPath } from '@sdk';
import { recordContentRef, vfsEditorTarget } from '@src/components/assets/editor/AssetEditorRouter';

describe('recordContentRef', () => {
  const authority = new TypeId('compute_node', 'd6978791-9503-5f73-a4f2-d85e581a4fff');

  it('gives a whiteboard editor the folder containing its primary markdown file', () => {
    const mainRef = new FSRef('/tmp/board/WHITE_BOARD.md', authority, 'text');

    const contentRef = recordContentRef(mainRef, true);

    expect(contentRef.path).toBe('/tmp/board');
    expect(contentRef.refType).toBe('folder');
    expect(contentRef.child('board.json').path).toBe('/tmp/board/board.json');
  });

  it('leaves file-layout editor refs on their primary content file', () => {
    const mainRef = new FSRef('/tmp/note.md', authority, 'text');

    expect(recordContentRef(mainRef, false)).toBe(mainRef);
  });
});

describe('vfsEditorTarget', () => {
  const agentShape = { kind: 'folder', main: 'agent.json' } as const;
  const occurrence = (value: string) => {
    const vfs = VFSPath.parse(value);
    return new FSRef(vfs.entitySubPath, vfs.typeId!);
  };

  it('reads a folder-addressed agent through its agent.json, not the folder', () => {
    const folder = occurrence('compute_node-@local/Users/me/proj/agentic-assets/agent/agent111');

    const { fsRef, mainFileRef } = vfsEditorTarget(folder, 'agent', agentShape);

    expect(fsRef).toBe(folder);
    expect(mainFileRef.path).toBe('Users/me/proj/agentic-assets/agent/agent111/agent.json');
  });

  it('keeps a pointer that already names the main file', () => {
    const main = occurrence('compute_node-@local/Users/me/proj/agentic-assets/agent/agent111/agent.json');

    expect(vfsEditorTarget(main, 'agent', agentShape).mainFileRef.path).toBe(main.path);
  });
});

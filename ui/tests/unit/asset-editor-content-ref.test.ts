import { describe, expect, it } from 'vitest';

import { FSRef, TypeId } from '@sdk';
import { recordContentRef } from '@src/components/assets/editor/AssetEditorRouter';

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

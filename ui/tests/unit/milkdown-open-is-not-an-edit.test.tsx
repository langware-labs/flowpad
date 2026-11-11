/**
 * Opening a document in the editor must not change it. The agent page's Instructions editor
 * emitted a re-serialized body on mount (the `trailing` plugin's empty paragraph = one more
 * newline), so the draft was dirty before anyone typed and the next save of any field rewrote
 * system_prompt.md and git auto-committed it ("Flowpad: <agent> vN" per page visit).
 */
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor, defaultValueCtx, editorViewCtx, remarkStringifyOptionsCtx, rootCtx, serializerCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { MilkdownEditor } from '@src/components/milkdown-editor/MilkdownEditor';
import { sourceBullet, tightLists } from '@src/components/milkdown-editor/plugins/list-spread';

const PROMPT = readFileSync(join(__dirname, 'fixtures/procurement-system-prompt.md'), 'utf8');

afterEach(cleanup);

async function roundTrip(markdown: string): Promise<string> {
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, document.createElement('div'));
      ctx.set(defaultValueCtx, markdown);
      ctx.update(remarkStringifyOptionsCtx, (prev) => tightLists(prev, sourceBullet(markdown)));
    })
    .use(commonmark)
    .use(gfm)
    .create();
  const out = editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));
  await editor.destroy();
  return out;
}

describe('opening a document in the editor', () => {
  it('emits no change for the real procurement system_prompt.md', async () => {
    const onChange = vi.fn();
    render(<MemoryRouter><MilkdownEditor content={PROMPT} onChange={onChange} editorMode="editor" /></MemoryRouter>);
    // The editor initialises asynchronously; give it time to emit whatever it would.
    await new Promise((r) => setTimeout(r, 1000));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('serializes the real system_prompt.md back to itself', async () => {
    expect(await roundTrip(PROMPT)).toBe(PROMPT);
  });

  it('keeps a `*` bullet source on `*` bullets', async () => {
    const star = '## Limits\n\n* One.\n* Two.\n';
    expect(await roundTrip(star)).toBe(star);
  });

  it('reads the bullet from list items, not fences or rules', () => {
    expect(sourceBullet('```\n* code\n```\n\n- real\n')).toBe('-');
    expect(sourceBullet('* * *\n\n+ item\n')).toBe('+');
    expect(sourceBullet('No lists.\n')).toBe('-');
  });
});

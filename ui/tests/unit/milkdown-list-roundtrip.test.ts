/**
 * Saving untouched markdown through the editor must give the same text back. Milkdown's
 * commonmark preset wrote every tight list loose and with `*` bullets, so a one-word edit to
 * an agent prompt rewrote the whole file. `tightLists` is the editor's fix for that.
 */
import { describe, expect, it } from 'vitest';
import { Editor, defaultValueCtx, editorViewCtx, remarkStringifyOptionsCtx, rootCtx, serializerCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { tightLists } from '@src/components/milkdown-editor/plugins/list-spread';

async function roundTrip(markdown: string, fix = true): Promise<string> {
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, document.createElement('div'));
      ctx.set(defaultValueCtx, markdown);
      if (fix) ctx.update(remarkStringifyOptionsCtx, tightLists);
    })
    .use(commonmark)
    .use(gfm)
    .create();
  const out = editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));
  await editor.destroy();
  return out;
}

const TIGHT = '## Hard limits\n\n- Never buy.\n- Never ask for card details.\n  Second line of the item.\n- Only procurement.\n';

describe('editor markdown round trip', () => {
  it('keeps a tight dash list as written', async () => {
    expect(await roundTrip(TIGHT)).toBe(TIGHT);
  });

  it('keeps a loose list loose', async () => {
    const loose = '- One.\n\n- Two.\n';
    expect(await roundTrip(loose)).toBe(loose);
  });

  it('keeps a tight ordered list tight', async () => {
    const ordered = '1. First.\n2. Second.\n';
    expect(await roundTrip(ordered)).toBe(ordered);
  });

  it('is what the stock preset gets wrong (guards the fix is still needed)', async () => {
    expect(await roundTrip(TIGHT, false)).not.toBe(TIGHT);
  });
});

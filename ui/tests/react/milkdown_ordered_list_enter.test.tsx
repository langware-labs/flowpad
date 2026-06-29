/**
 * RCA repro — pressing Enter at the end of an ordered-list item must create a
 * SECOND list_item (so the list renders "1." then "2."), not a second paragraph
 * nested inside the same list_item ("tabbed offset, still 1.").
 *
 * Faithful repro: builds the REAL Milkdown editor with the same plugin stack the
 * app uses (commonmark + gfm + bidiPlugins). No mocks — the bug lives in the real
 * keymap precedence (the bidi `$prose` Enter keymap is ordered before Milkdown's
 * managed listItemKeymap) combined with the guard in `enter-inherit.ts` that
 * claims Enter for any `paragraph` parent, including a list item's paragraph.
 *
 * Enter is dispatched through the real ProseMirror keydown chain via
 * `view.someProp('handleKeyDown', …)`, which iterates plugins in array order and
 * returns the first handler that claims the event — exactly the production path.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { TextSelection } from '@milkdown/prose/state';
import { bidiPlugins } from '../../src/components/milkdown-editor/plugins/bidi';

let root: HTMLElement | null = null;
let editor: Editor | null = null;

afterEach(async () => {
  await editor?.destroy();
  editor = null;
  root?.remove();
  root = null;
});

describe('markdown editor — ordered list Enter continuation', () => {
  it('Enter at end of item 1 creates a second list_item (renders "2."), not a nested paragraph', async () => {
    root = document.createElement('div');
    document.body.appendChild(root);

    editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root!);
        ctx.set(defaultValueCtx, '1. First item\n');
      })
      .use(commonmark)
      .use(gfm)
      .use(bidiPlugins)
      .create();

    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);

      // Locate the ordered_list and place the caret at the END of item 1's text.
      const doc = view.state.doc;
      let listPos = -1;
      doc.descendants((node, pos) => {
        if (node.type.name === 'ordered_list' && listPos === -1) listPos = pos;
        return true;
      });
      expect(listPos, 'ordered_list should exist in parsed doc').toBeGreaterThanOrEqual(0);

      const orderedList = doc.nodeAt(listPos)!;
      expect(orderedList.childCount).toBe(1); // one item to start

      // End of the first item's paragraph text.
      const paragraph = orderedList.child(0).child(0);
      const endOfText = listPos + 1 /*into list*/ + 1 /*into list_item*/ + 1 /*into paragraph*/ + paragraph.content.size;
      const tr = view.state.tr.setSelection(
        TextSelection.create(view.state.doc, endOfText),
      );
      view.dispatch(tr);

      // Real Enter through the real keydown chain (respects plugin precedence).
      const handled = view.someProp('handleKeyDown', (f) =>
        f(view, new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter' })),
      );
      expect(handled, 'some keymap should handle Enter').toBe(true);

      // After Enter: the ordered_list must now have TWO list_items (1. / 2.).
      const newDoc = view.state.doc;
      let newList: import('@milkdown/prose/model').Node | null = null;
      newDoc.descendants((node) => {
        if (node.type.name === 'ordered_list' && !newList) newList = node;
        return true;
      });
      expect(newList, 'ordered_list still present after Enter').not.toBeNull();

      const itemCount = newList!.childCount;
      const firstItemParagraphs = newList!.child(0).childCount;

      // PROVEN BUG: bidi's Enter does a generic depth-1 split → the ordered_list
      // still has ONE list_item that now holds TWO paragraphs (the indented,
      // still-"1." line). Correct behaviour = TWO list_items, one paragraph each.
      expect(
        itemCount,
        `expected 2 list items (1. and 2.), got ${itemCount} item(s) with ${firstItemParagraphs} paragraph(s) in item 1`,
      ).toBe(2);
    });
  });
});

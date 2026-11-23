/**
 * A caret between two rendered blocks.
 *
 * A rendered fence hides its source, so to the reader it is one solid thing —
 * but to ProseMirror it is still a text block, and its gap-cursor rule ("no gap
 * where a text caret can already go") refuses the place between two of them, or
 * between one and the edge of the document. With no position to give, a click
 * there sent the caret to whatever text the browser found, usually the title.
 *
 * So: the standard gap cursor, plus two rules of our own.
 *
 * - A click that lands between rendered blocks (or between one and a document
 *   edge) puts the gap cursor there.
 * - Typing at it starts a paragraph in that place, and Enter an empty one.
 *   Left alone, ProseMirror wraps the typed character in the first block the
 *   schema allows at the top level, which is a heading.
 */

import { GapCursor, gapCursor } from '@milkdown/prose/gapcursor';
import type { Node as PMNode } from '@milkdown/prose/model';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';

import { CODE_BLOCK_NODE } from './fence-mode';
import { getFenceRenderer } from './registry';

const rendered = (node: PMNode | null | undefined): boolean =>
  !!node && node.type.name === CODE_BLOCK_NODE && !!getFenceRenderer(node.attrs.language as string);

/**
 * Whether `pos` is a place only a gap cursor can hold: at the top level, with a
 * rendered block on one side and a rendered block or a document edge on the other.
 */
export function isFenceGap(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(pos);
  if ($pos.depth !== 0) return false;
  const { nodeBefore, nodeAfter } = $pos;
  if (!rendered(nodeBefore) && !rendered(nodeAfter)) return false;
  return (!nodeBefore || rendered(nodeBefore)) && (!nodeAfter || rendered(nodeAfter));
}

export const fenceGapKey = new PluginKey('flowpad-fence-gap');

/** Where the gap cursor is, when it sits between rendered blocks. */
function gapOf(state: EditorState): number | null {
  const { selection } = state;
  return selection instanceof GapCursor && isFenceGap(state, selection.head) ? selection.head : null;
}

/** Start a paragraph holding `text` at the gap, with the caret at its end. */
function writeAtGap(view: EditorView, pos: number, text: string): void {
  const paragraph = view.state.schema.nodes.paragraph.create(null, text ? view.state.schema.text(text) : null);
  const tr = view.state.tr.insert(pos, paragraph);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1 + text.length)).scrollIntoView());
}

/** Bare plugin, exported for tests on a plain `EditorState`. */
export function createFenceGapPlugin(): Plugin {
  return new Plugin({
    key: fenceGapKey,
    props: {
      handleClick(view, pos) {
        if (!view.editable || !isFenceGap(view.state, pos)) return false;
        view.dispatch(view.state.tr.setSelection(new GapCursor(view.state.doc.resolve(pos))));
        view.focus();
        return true;
      },
      // Left to ProseMirror, a character typed at the gap is wrapped in the first
      // block the schema allows there, which is a heading.
      handleTextInput(view, _from, _to, text) {
        const at = gapOf(view.state);
        if (at == null) return false;
        writeAtGap(view, at, text);
        return true;
      },
      handleKeyDown(view, event) {
        const at = event.key === 'Enter' ? gapOf(view.state) : null;
        if (at == null) return false;
        writeAtGap(view, at, '');
        return true;
      },
    },
  });
}

export const fenceGapPlugins = [$prose(() => gapCursor()), $prose(() => createFenceGapPlugin())];

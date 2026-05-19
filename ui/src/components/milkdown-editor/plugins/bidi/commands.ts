/**
 * ProseMirror commands that write the `dir` (and `align`) attrs on the
 * paragraph and heading nodes touched by the current selection.
 *
 * Skip rules — both are honored by every command in this file:
 *   - Non-textblock nodes are ignored (their children are recursed into by
 *     `nodesBetween`, so we still see the inner textblocks).
 *   - Only `paragraph` and `heading` are targets in phase 3–4. Blockquote
 *     and list_item join in phase 7. `code_block` is never a target — code
 *     is direction-agnostic.
 *
 * Setting attr to `null` is the "clear" path — the schema's `toMarkdown`
 * detects default-attr nodes and emits unwrapped CommonMark (see
 * `schema.ts`).
 */

import { $command } from '@milkdown/utils';
import type { Command } from '@milkdown/prose/state';

export type BidiDir = 'ltr' | 'rtl' | 'auto' | null;
export type BidiAlign = 'start' | 'end' | 'center' | 'justify' | null;

const BIDI_TARGET_TYPES: ReadonlySet<string> = new Set(['paragraph', 'heading']);

function isBidiTarget(typeName: string): boolean {
  return BIDI_TARGET_TYPES.has(typeName);
}

/** Write the same `dir` value to every paragraph/heading in the selection. */
export const setDirCommand = $command('SetBidiDir', () => (payload?: BidiDir): Command =>
  (state, dispatch) => {
    const { from, to } = state.selection;
    const tr = state.tr;
    let touched = false;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) return;
      if (!isBidiTarget(node.type.name)) return;
      tr.setNodeAttribute(pos, 'dir', payload ?? null);
      touched = true;
    });
    if (touched && dispatch) dispatch(tr);
    return touched;
  }
);

/** Clear `dir` (and only `dir`) on every paragraph/heading in the selection. */
export const unsetDirCommand = $command('UnsetBidiDir', () => (): Command =>
  (state, dispatch) => {
    const { from, to } = state.selection;
    const tr = state.tr;
    let touched = false;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) return;
      if (!isBidiTarget(node.type.name)) return;
      if (node.attrs.dir == null) return;
      tr.setNodeAttribute(pos, 'dir', null);
      touched = true;
    });
    if (touched && dispatch) dispatch(tr);
    return touched;
  }
);

/** Write the same `align` value to every paragraph/heading in the selection. */
export const setAlignCommand = $command('SetBidiAlign', () => (payload?: BidiAlign): Command =>
  (state, dispatch) => {
    const { from, to } = state.selection;
    const tr = state.tr;
    let touched = false;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) return;
      if (!isBidiTarget(node.type.name)) return;
      tr.setNodeAttribute(pos, 'align', payload ?? null);
      touched = true;
    });
    if (touched && dispatch) dispatch(tr);
    return touched;
  }
);

/** Clear `align` (and only `align`) on every paragraph/heading in the selection. */
export const unsetAlignCommand = $command('UnsetBidiAlign', () => (): Command =>
  (state, dispatch) => {
    const { from, to } = state.selection;
    const tr = state.tr;
    let touched = false;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) return;
      if (!isBidiTarget(node.type.name)) return;
      if (node.attrs.align == null) return;
      tr.setNodeAttribute(pos, 'align', null);
      touched = true;
    });
    if (touched && dispatch) dispatch(tr);
    return touched;
  }
);

/** Spread into the editor's plugin list. */
export const bidiCommandPlugins = [
  setDirCommand,
  unsetDirCommand,
  setAlignCommand,
  unsetAlignCommand,
];

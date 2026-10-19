/**
 * `Enter` handler for paragraph and heading blocks. Two jobs:
 *
 *  1. **Word-style attr inheritance**: when the cursor sits inside a block
 *     that has explicit `dir` and/or `align` attrs, the new block after
 *     `Enter` inherits those same attrs. Default `splitBlock` drops them
 *     and the next line "falls back" to default, surprising users who
 *     just chose RTL.
 *
 *  2. **Override default block-type pick**: because we extend the
 *     paragraph and heading schemas via `extendSchema`, the schema's
 *     content-match order shifts and prosemirror-commands' built-in
 *     `defaultBlockAt` returns `code_block` first under our preset combo.
 *     The result without this handler is that pressing `Enter` at the
 *     end of any paragraph creates a code block — broken UX. So we
 *     always own the split for paragraph/heading parents and explicitly
 *     produce a paragraph (or preserve the heading on mid-block split).
 *
 * Implementation notes:
 *
 *   - `Enter` inside a code_block, list_item, blockquote, table_cell,
 *     etc. is left to upstream handlers — we only claim paragraph and
 *     heading directly.
 *
 *   - Mid-block split inside a heading: the new block stays a heading (so
 *     the second half of the title remains styled). It inherits the
 *     heading's bidi attrs.
 */

import { $prose } from '@milkdown/utils';
import { keymap } from '@milkdown/prose/keymap';
import { TextSelection, NodeSelection, type Command } from '@milkdown/prose/state';
import { canSplit } from '@milkdown/prose/transform';
import type { NodeType } from '@milkdown/prose/model';

/** Same shape as `prosemirror-commands` `splitBlock`, but inherits the parent's
 *  bidi attrs onto the new block and always picks paragraph as the post-end
 *  type (instead of relying on the schema's content-match order). */
const bidiInheritOnEnter: Command = (state, dispatch) => {
  const { selection } = state;
  const $from = selection.$from;
  const $to = selection.$to;
  const parent = $from.parent;
  const parentType = parent.type.name;

  if (parentType !== 'paragraph' && parentType !== 'heading') return false;

  // A list item's content is a `paragraph`, so the parent-type check above
  // passes inside list items too. Defer those to Milkdown's listItemKeymap
  // (NextListItem → splitListItem), which renumbers the list; our generic
  // depth-1 split would instead nest a second paragraph in the same item.
  if ($from.node(-1)?.type.name === 'list_item') return false;

  // NodeSelection on a block — defer to default splitBlock semantics (rare path).
  if (selection instanceof NodeSelection && selection.node.isBlock) return false;
  if (!parent.isBlock) return false;

  if (!dispatch) return true;

  const inherited = {
    dir: parent.attrs.dir ?? null,
    align: parent.attrs.align ?? null,
  };

  const tr = state.tr;
  if (selection instanceof TextSelection) tr.deleteSelection();

  const atEnd = $to.parentOffset === $to.parent.content.size;
  // Word-like new-block type:
  //   heading + Enter at end → paragraph (drops to body for the next line)
  //   heading + Enter mid    → heading (split preserves the level for both halves)
  //   paragraph + Enter (any) → paragraph
  // (We deliberately don't reuse prosemirror's `defaultBlockAt` here — in our
  // schema it returns `code_block` first under some configurations, which is
  // never the right post-Enter block.)
  const paragraphType = state.schema.nodes.paragraph;
  const newType: NodeType =
    atEnd && parentType === 'heading' ? paragraphType : parent.type;
  // Only spread bidi attrs into types that actually declare them. Heading no
  // longer carries dir/align (see ``schema.ts`` header — Milkdown plugin bug
  // forces paragraph-only scope). Passing unknown attrs to ``node.create``
  // would throw "Unsupported attribute".
  const supportsBidi = 'dir' in (newType.spec.attrs ?? {});
  // `attrs` may leave out anything the schema gives a default: ProseMirror's
  // `computeAttrs` fills those in when the node is built. (The old
  // `...newType.defaultAttrs` spread was reading a NodeType internal that isn't
  // in prosemirror-model's typings — and is `null` whenever any attribute has
  // no default, so it contributed nothing then either.)
  const typesAfter = [{
    type: newType,
    attrs: supportsBidi ? { ...inherited } : null,
  }];

  const splitPos = tr.mapping.map($from.pos);
  if (!canSplit(tr.doc, splitPos, 1, typesAfter)) {
    // Schema rejects our typesAfter — bail and let default handler take over.
    return false;
  }

  tr.split(splitPos, 1, typesAfter);
  dispatch(tr.scrollIntoView());
  return true;
};

export const bidiEnterInheritPlugin = $prose(() => keymap({ Enter: bidiInheritOnEnter }));

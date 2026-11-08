/**
 * A doc's comment threads, drawn on the text they are about: a soft highlight
 * over the quoted passage and, right after the block that holds it, a slot the
 * host renders the comment's card into (a React portal). Display only — the
 * markdown never changes, so it works the same in a read-only view.
 *
 * A comment carries its quote, not a position: the doc moves under it (a person
 * types above it, a worker rewrites the file), so each one is re-found on every
 * doc change. A quote that is gone draws nothing here — its slot is not in the
 * page, which is how the host tells it to say "the quoted text changed".
 */
import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey, type EditorState } from '@milkdown/prose/state';
import type { Node as PMNode } from '@milkdown/prose/model';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { create } from 'zustand';
import { resolveChangeMark } from './change-marks';

/** Comment ids the doc currently draws — a quote that is gone is not in it — and, for
 *  those whose whole quote was rewritten, the text of the passage they now sit on. */
export const usePlacedComments = create<{ ids: ReadonlySet<string>; moved: Readonly<Record<string, string>> }>(() => ({
  ids: new Set(),
  moved: {},
}));

/** Rewritten quotes found this build: id → the passage's text now. */
const movedNow = new Map<string, string>();

export interface CommentAnchorMark {
  id: string;
  quote: string;
}

interface CommentWidgetsState {
  marks: readonly CommentAnchorMark[];
  decorations: DecorationSet;
}

export const commentWidgetsKey = new PluginKey<CommentWidgetsState>('flowpad-comment-widgets');

/** One slot element per comment for the page's life, so the host's portal into it
 *  survives every rebuild of the decorations. */
const slots = new Map<string, HTMLElement>();

export function commentSlot(id: string): HTMLElement {
  let el = slots.get(id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'flowpad-comment-slot';
    el.dataset.commentSlot = id;
    el.contentEditable = 'false';
    slots.set(id, el);
  }
  return el;
}

/**
 * Where a quote is now, or null when it is gone. A passage a worker rewrote (the
 * change request it answered) usually keeps its opening words: when the whole
 * quote is gone, the longest opening of at least three words still found is
 * where the comment stays.
 */
export function resolveQuote(doc: PMNode, quote: string): { from: number; to: number } | null {
  const find = (q: string) => resolveChangeMark(doc, { id: '', quote: q, from: -1, to: -1, n: 0 });
  const exact = find(quote);
  if (exact) return exact;
  const words = quote.split(/\s+/).filter(Boolean);
  for (let n = words.length - 1; n >= 3; n--) {
    const at = find(words.slice(0, n).join(' '));
    if (at) return at;
  }
  return null;
}

/** The top-level block each comment last sat after: when a rewrite removes its whole
 *  quote, the card stays where it was (without a highlight) instead of vanishing. */
const lastBlock = new Map<string, number>();

/** The position after top-level block `index`, or null when the doc is shorter. */
function afterBlock(doc: PMNode, index: number): number | null {
  if (index >= doc.childCount) return null;
  let pos = 0;
  for (let i = 0; i <= index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

function build(doc: PMNode, marks: readonly CommentAnchorMark[]): DecorationSet {
  const decorations: Decoration[] = [];
  movedNow.clear();
  // Keep per-comment memory only for the comments this doc still has.
  const live = new Set(marks.map((m) => m.id));
  for (const id of [...lastBlock.keys()]) if (!live.has(id)) lastBlock.delete(id);
  for (const id of [...slots.keys()]) if (!live.has(id)) slots.delete(id);
  for (const mark of marks) {
    const at = mark.quote ? resolveQuote(doc, mark.quote) : null;
    let after: number | null;
    if (at && doc.textBetween(at.from, at.to, '\n') !== mark.quote) {
      // Found by its opening words only: the passage was rewritten.
      movedNow.set(mark.id, doc.resolve(at.to).node(1).textContent);
    }
    if (at) {
      // After the top-level block that holds the passage: a card is a block, never inside a line.
      const $end = doc.resolve(at.to);
      after = $end.depth >= 1 ? $end.after(1) : at.to;
      lastBlock.set(mark.id, $end.index(0));
      decorations.push(Decoration.inline(at.from, at.to, { class: 'flowpad-comment-mark', 'data-comment-id': mark.id }));
    } else {
      const index = lastBlock.get(mark.id);
      after = index === undefined ? null : afterBlock(doc, index);
      if (after != null && index !== undefined) movedNow.set(mark.id, doc.child(index).textContent);
    }
    if (after == null) continue;
    decorations.push(
      Decoration.widget(after, () => commentSlot(mark.id), {
        side: 1,
        key: `comment-slot-${mark.id}`,
        // The card owns its own inputs and clicks.
        stopEvent: () => true,
        ignoreSelection: true,
      }),
    );
  }
  return DecorationSet.create(doc, decorations);
}

/** Bare plugin, exported for tests on a plain `EditorState`. */
export function createCommentWidgetsPlugin(): Plugin<CommentWidgetsState> {
  return new Plugin<CommentWidgetsState>({
    key: commentWidgetsKey,
    state: {
      init: (_config, state: EditorState) => ({ marks: [], decorations: DecorationSet.create(state.doc, []) }),
      apply: (tr, value, _old, state) => {
        const next = tr.getMeta(commentWidgetsKey) as readonly CommentAnchorMark[] | undefined;
        if (!next && !tr.docChanged) return value;
        const marks = next ?? value.marks;
        return { marks, decorations: build(state.doc, marks) };
      },
    },
    props: {
      decorations: (state) => commentWidgetsKey.getState(state)?.decorations ?? null,
    },
    view: () => ({
      update: (view, prevState) => {
        // Cursor moves and other transactions that leave the plugin state alone change nothing here.
        if (commentWidgetsKey.getState(view.state) === commentWidgetsKey.getState(prevState)) return;
        const placed = new Set<string>();
        for (const d of commentWidgetsKey.getState(view.state)?.decorations.find() ?? []) {
          const id = (d.spec as { key?: string }).key?.replace(/^comment-slot-/, '');
          if (id && (d.spec as { key?: string }).key?.startsWith('comment-slot-')) placed.add(id);
        }
        const { ids: prev, moved: prevMoved } = usePlacedComments.getState();
        const moved = Object.fromEntries(movedNow);
        const sameMoved = JSON.stringify(moved) === JSON.stringify(prevMoved);
        if (placed.size !== prev.size || [...placed].some((id) => !prev.has(id)) || !sameMoved)
          usePlacedComments.setState({ ids: placed, moved });
      },
    }),
  });
}

export const commentWidgetsPlugin = $prose(() => createCommentWidgetsPlugin());

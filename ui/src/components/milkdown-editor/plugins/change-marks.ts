/**
 * Queued "change this" requests, shown on the text they are about: a soft
 * highlight over the range and a numbered pin at its end (the number matches
 * the row in the Changes side tab). Display only — nothing is written to the
 * document.
 *
 * A request carries the range it was made on AND the text that was selected.
 * The doc moves under it (the user types above it, a worker rewrites it, the
 * file reloads), so each mark is re-resolved on every doc change: the stored
 * range while it still holds the quote, else the first place the quote occurs.
 * A quote that no longer occurs anywhere shows no mark.
 */
import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey, type EditorState } from '@milkdown/prose/state';
import type { Node as PMNode } from '@milkdown/prose/model';
import { Decoration, DecorationSet } from '@milkdown/prose/view';

export interface ChangeMark {
  id: string;
  quote: string;
  from: number;
  to: number;
  /** 1-based number shown in the pin — the row's number in the list. */
  n: number;
  /** Sent to a worker: drawn quieter. */
  sent?: boolean;
}

interface ChangeMarksState {
  marks: readonly ChangeMark[];
  decorations: DecorationSet;
}

export const changeMarksKey = new PluginKey<ChangeMarksState>('flowpad-change-marks');

/** Where `mark` is in `doc` now, or null when its text is gone. */
export function resolveChangeMark(doc: PMNode, mark: ChangeMark): { from: number; to: number } | null {
  const size = doc.content.size;
  if (mark.from >= 0 && mark.to <= size && mark.from < mark.to) {
    if (doc.textBetween(mark.from, mark.to, '\n').trim() === mark.quote) return { from: mark.from, to: mark.to };
  }
  // A quote inside one block: find it in that block's text.
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (!node.isTextblock) return true;
    const text = node.textContent;
    const at = text.indexOf(mark.quote);
    if (at < 0) return false;
    const start = posAtTextOffset(node, pos + 1, at);
    const end = posAtTextOffset(node, pos + 1, at + mark.quote.length);
    if (start != null && end != null) found = { from: start, to: end };
    return false;
  });
  return found;
}

/** The doc position of character `offset` in a textblock whose content starts at `start`. */
function posAtTextOffset(block: PMNode, start: number, offset: number): number | null {
  let seen = 0;
  let result: number | null = null;
  block.forEach((child, childOffset) => {
    if (result != null) return;
    // A leaf like a hard break has no text of its own but counts in `textContent` (its leafText).
    const len = child.textContent.length;
    if (offset <= seen + len) result = start + childOffset + (offset - seen);
    seen += len;
  });
  return result ?? (offset === seen ? start + block.content.size : null);
}

function pin(mark: ChangeMark): HTMLElement {
  const el = document.createElement('span');
  el.className = 'flowpad-change-pin';
  el.dataset.testid = 'change-pin';
  el.dataset.sent = mark.sent ? 'true' : 'false';
  el.textContent = String(mark.n);
  el.contentEditable = 'false';
  return el;
}

function build(doc: PMNode, marks: readonly ChangeMark[]): DecorationSet {
  const decorations: Decoration[] = [];
  for (const mark of marks) {
    const at = resolveChangeMark(doc, mark);
    if (!at) continue;
    decorations.push(
      Decoration.inline(at.from, at.to, {
        class: mark.sent ? 'flowpad-change-mark flowpad-change-mark-sent' : 'flowpad-change-mark',
        'data-change-id': mark.id,
      }),
      Decoration.widget(at.to, () => pin(mark), {
        side: 1,
        key: `change-pin-${mark.id}-${mark.n}-${mark.sent ? 1 : 0}`,
      }),
    );
  }
  return DecorationSet.create(doc, decorations);
}

/** Bare plugin, exported for tests on a plain `EditorState`. */
export function createChangeMarksPlugin(): Plugin<ChangeMarksState> {
  return new Plugin<ChangeMarksState>({
    key: changeMarksKey,
    state: {
      init: (_config, state: EditorState) => ({ marks: [], decorations: DecorationSet.create(state.doc, []) }),
      apply: (tr, value, _old, state) => {
        const next = tr.getMeta(changeMarksKey) as readonly ChangeMark[] | undefined;
        if (!next && !tr.docChanged) return value;
        const marks = next ?? value.marks;
        return { marks, decorations: build(state.doc, marks) };
      },
    },
    props: {
      decorations: (state) => changeMarksKey.getState(state)?.decorations ?? null,
    },
  });
}

export const changeMarksPlugin = $prose(() => createChangeMarksPlugin());

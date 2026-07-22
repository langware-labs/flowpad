/**
 * Per-block tab state for renderable code fences (Render | Code).
 *
 * **Why this is plugin state and not NodeView state.** ProseMirror destroys and
 * recreates NodeViews freely as the document changes — a tab kept on the view
 * instance would reset on the next keystroke. And it can't go in the document
 * either: the tab is view state, and writing it into the markdown would break
 * the round-trip guarantee that makes this whole feature safe. So it lives
 * here, as a map of explicit user overrides keyed by the block's position,
 * remapped through `tr.mapping` on every transaction so the key survives edits
 * above the block.
 *
 * The plugin emits a `Decoration.node` carrying `spec.fenceMode` on every
 * `code_block` that has a registered renderer. Decoration changes are what make
 * ProseMirror call `NodeView.update(node, decorations)`, so this doubles as the
 * mechanism that drives the view.
 *
 * **Caret precedence.** A caret inside the block always forces `'code'`. If the
 * source were hidden while the selection sat inside it, the caret would have
 * nowhere to render and typing would go somewhere invisible. `setFenceMode`
 * handles the other direction: switching *to* render moves the selection out of
 * the node first, so it's never stranded in a hidden `contentDOM`.
 */

import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import type { EditorView } from '@milkdown/prose/view';
import { getFenceRenderer } from './registry';

export type FenceMode = 'render' | 'code';

export const CODE_BLOCK_NODE = 'code_block';

interface FenceModeState {
  /** Explicit user tab picks, keyed by the block's start position. */
  overrides: Map<number, FenceMode>;
}

interface SetFenceModeMeta {
  pos: number;
  mode: FenceMode;
}

export const fenceModeKey = new PluginKey<FenceModeState>('flowpad-fence-mode');

/** Read the mode a decoration set carries, defaulting to `'render'`. */
export function fenceModeFromDecorations(decorations: readonly Decoration[]): FenceMode {
  for (const deco of decorations) {
    const mode = (deco.spec as { fenceMode?: FenceMode } | undefined)?.fenceMode;
    if (mode) return mode;
  }
  return 'render';
}

/**
 * Build the transaction that switches a block's tab, or `null` if `pos` isn't a
 * code block. Selecting `'render'` also pushes the selection to just *after*
 * the node — otherwise the caret-precedence rule would immediately flip it back
 * to `'code'`. Selecting `'code'` puts the caret in the source so the user can
 * type straight away, the same end state as clicking into the block.
 *
 * Split out from `setFenceMode` so the selection behaviour is unit-testable
 * without an `EditorView`.
 */
export function fenceModeTransaction(state: EditorState, pos: number, mode: FenceMode): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node || node.type.name !== CODE_BLOCK_NODE) return null;

  const meta: SetFenceModeMeta = { pos, mode };
  const tr: Transaction = state.tr.setMeta(fenceModeKey, meta);

  const target =
    mode === 'render' ? Math.min(pos + node.nodeSize, tr.doc.content.size) : pos + 1;
  return tr.setSelection(TextSelection.near(tr.doc.resolve(target), 1));
}

/** Switch a block's tab and keep focus in the editor. */
export function setFenceMode(view: EditorView, pos: number, mode: FenceMode): void {
  const tr = fenceModeTransaction(view.state, pos, mode);
  if (!tr) return;
  view.dispatch(tr);
  view.focus();
}

/** True when the selection sits inside this block. */
function caretInside(state: EditorState, pos: number, nodeSize: number): boolean {
  const { from, to } = state.selection;
  return from > pos && to < pos + nodeSize;
}

function buildDecorations(state: EditorState, overrides: Map<number, FenceMode>): DecorationSet {
  const decorations: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== CODE_BLOCK_NODE) return;
    if (!getFenceRenderer(node.attrs.language as string)) return;
    const mode: FenceMode = caretInside(state, pos, node.nodeSize)
      ? 'code'
      : (overrides.get(pos) ?? 'render');
    decorations.push(Decoration.node(pos, pos + node.nodeSize, {}, { fenceMode: mode }));
  });
  return DecorationSet.create(state.doc, decorations);
}

/**
 * The bare ProseMirror plugin, exported so tests can mount it on a plain
 * `EditorState` without a Milkdown context.
 */
export function createFenceModePlugin(): Plugin<FenceModeState> {
  return new Plugin<FenceModeState>({
    key: fenceModeKey,
    state: {
      init: () => ({ overrides: new Map() }),
      apply: (tr, value) => {
        const meta = tr.getMeta(fenceModeKey) as SetFenceModeMeta | undefined;
        // Nothing to do: no doc change to remap and no new pick.
        if (!tr.docChanged && !meta) return value;

        const next = new Map<number, FenceMode>();
        for (const [pos, mode] of value.overrides) {
          // A block deleted out from under an override drops it (`mapResult`
          // reports the position as deleted), which is what we want —
          // otherwise stale keys accumulate for the life of the editor.
          const result = tr.mapping.mapResult(pos);
          if (result.deleted) continue;
          next.set(result.pos, mode);
        }
        if (meta) next.set(meta.pos, meta.mode);
        return { overrides: next };
      },
    },
    props: {
      decorations: (state) => {
        const pluginState = fenceModeKey.getState(state);
        return buildDecorations(state, pluginState?.overrides ?? new Map());
      },
    },
  });
}

export const fenceModePlugin = $prose(() => createFenceModePlugin());

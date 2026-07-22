/**
 * Tab state for renderable code fences.
 *
 * These run against a real `EditorState` with a minimal ProseMirror schema
 * rather than a full Milkdown editor — the logic under test is position
 * remapping and caret precedence, neither of which needs the preset.
 */

import {
  createFenceModePlugin,
  fenceModeFromDecorations,
  fenceModeTransaction,
  type FenceMode,
} from '@src/components/milkdown-editor/plugins/fence-render/fence-mode';
import {
  clearFenceRenderers,
  registerFenceRenderer,
} from '@src/components/milkdown-editor/plugins/fence-render/registry';
import { Schema, type Node as PMNode } from '@milkdown/prose/model';
import { EditorState, TextSelection, type Transaction } from '@milkdown/prose/state';
import type { DecorationSet } from '@milkdown/prose/view';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Mirrors the shape commonmark gives `code_block`: a text-only block carrying
// the fence info string in a `language` attr.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0] },
    code_block: {
      content: 'text*',
      group: 'block',
      code: true,
      marks: '',
      attrs: { language: { default: '' } },
      toDOM: () => ['pre', ['code', 0]],
    },
    text: { inline: true },
  },
});

function para(text: string): PMNode {
  return schema.nodes.paragraph.create(null, text ? schema.text(text) : null);
}

function fence(language: string, code: string): PMNode {
  return schema.nodes.code_block.create({ language }, schema.text(code));
}

function stateWith(...content: PMNode[]): EditorState {
  return EditorState.create({
    doc: schema.nodes.doc.create(null, content),
    plugins: [createFenceModePlugin()],
  });
}

/** Position of the nth `code_block` in the doc — never hardcode these. */
function fencePos(state: EditorState, index = 0): number {
  const found: number[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'code_block') found.push(pos);
  });
  const pos = found[index];
  if (pos == null) throw new Error(`no code_block at index ${index}`);
  return pos;
}

/** The mode the plugin's decorations report for the block starting at `pos`. */
function modeAt(state: EditorState, pos: number): FenceMode | null {
  const plugin = state.plugins[0];
  const set = plugin.props.decorations?.call(plugin, state) as DecorationSet | undefined;
  if (!set) return null;
  const node = state.doc.nodeAt(pos);
  if (!node) return null;
  const found = set.find(pos, pos + node.nodeSize);
  const own = found.filter((d) => d.from === pos);
  return own.length ? fenceModeFromDecorations(own) : null;
}

function apply(state: EditorState, tr: Transaction): EditorState {
  return state.apply(tr);
}

beforeEach(() => {
  registerFenceRenderer({ language: 'mermaid', tabLabel: 'Diagram', render: () => {} });
});
afterEach(() => clearFenceRenderers());

describe('fence mode decorations', () => {
  it('defaults a renderable fence to render mode', () => {
    const state = stateWith(para('before'), fence('mermaid', 'graph TD;'));
    expect(modeAt(state, fencePos(state))).toBe('render');
  });

  it('emits no decoration for a fence without a renderer', () => {
    const state = stateWith(para('before'), fence('python', 'x = 1'));
    expect(modeAt(state, fencePos(state))).toBeNull();
  });

  /*
   * Caret precedence. If the source stayed hidden while the selection sat
   * inside it, the caret would have nowhere to render and typing would go
   * somewhere invisible.
   */
  it('forces code mode while the caret is inside the block', () => {
    const base = stateWith(para('before'), fence('mermaid', 'graph TD;'));
    const pos = fencePos(base);
    const inside = apply(base, base.tr.setSelection(TextSelection.create(base.doc, pos + 2)));
    expect(modeAt(inside, pos)).toBe('code');
  });

  it('returns to render mode once the caret leaves', () => {
    const base = stateWith(para('before'), fence('mermaid', 'graph TD;'));
    const pos = fencePos(base);
    const inside = apply(base, base.tr.setSelection(TextSelection.create(base.doc, pos + 2)));
    const outside = apply(inside, inside.tr.setSelection(TextSelection.create(inside.doc, 2)));
    expect(modeAt(outside, pos)).toBe('render');
  });

  it('keeps an explicit code override while the caret is elsewhere', () => {
    const base = stateWith(para('before'), fence('mermaid', 'graph TD;'));
    const pos = fencePos(base);
    const tr = fenceModeTransaction(base, pos, 'code');
    expect(tr).not.toBeNull();
    let next = apply(base, tr!);
    // Move the caret well away from the block; the override should survive.
    next = apply(next, next.tr.setSelection(TextSelection.create(next.doc, 2)));
    expect(modeAt(next, pos)).toBe('code');
  });

  /*
   * The reason tab state lives in plugin state at all: it is keyed by document
   * position, so an edit ABOVE the block shifts that key. Without remapping
   * through `tr.mapping`, the override would silently detach and the tab would
   * snap back to render on the next keystroke anywhere earlier in the doc.
   */
  it('remaps the override when text is inserted above the block', () => {
    const base = stateWith(para('before'), fence('mermaid', 'graph TD;'));
    const pos = fencePos(base);
    let state = apply(base, fenceModeTransaction(base, pos, 'code')!);

    const insertion = ' MUCH LONGER TEXT';
    state = apply(state, state.tr.insertText(insertion, 4));

    // The block moved right by exactly the inserted length.
    const newPos = pos + insertion.length;
    expect(state.doc.nodeAt(newPos)?.type.name).toBe('code_block');
    expect(modeAt(state, newPos)).toBe('code');
  });

  it('remaps the override when a whole block is removed above it', () => {
    const base = stateWith(para('one'), para('two'), fence('mermaid', 'graph TD;'));
    const pos = fencePos(base);
    let state = apply(base, fenceModeTransaction(base, pos, 'code')!);

    const firstSize = para('one').nodeSize;
    state = apply(state, state.tr.delete(0, firstSize));

    const newPos = pos - firstSize;
    expect(state.doc.nodeAt(newPos)?.type.name).toBe('code_block');
    expect(modeAt(state, newPos)).toBe('code');
  });

  /*
   * Overrides are keyed by position, so a deleted block must drop its entry —
   * otherwise stale keys accumulate for the life of the editor and can collide
   * with an unrelated block that later occupies the same position.
   */
  it('drops the override when the block itself is deleted', () => {
    const base = stateWith(para('before'), fence('mermaid', 'graph TD;'));
    const pos = fencePos(base);
    let state = apply(base, fenceModeTransaction(base, pos, 'code')!);

    const size = state.doc.nodeAt(pos)!.nodeSize;
    state = apply(state, state.tr.delete(pos, pos + size));
    // Put a fresh fence back at the same position; it must start at render.
    state = apply(state, state.tr.insert(pos, fence('mermaid', 'graph LR;')));

    expect(modeAt(state, pos)).toBe('render');
  });

  it('tracks overrides for two blocks independently', () => {
    const base = stateWith(fence('mermaid', 'a'), para('mid'), fence('mermaid', 'b'));
    const firstPos = fencePos(base, 0);
    const secondPos = fencePos(base, 1);
    const state = apply(base, fenceModeTransaction(base, secondPos, 'code')!);

    expect(modeAt(state, firstPos)).toBe('render');
    expect(modeAt(state, secondPos)).toBe('code');
  });
});

describe('fenceModeTransaction selection handling', () => {
  /*
   * Switching to render must move the selection OUT of the node first —
   * otherwise caret precedence immediately overrules the override and the tab
   * appears not to respond at all.
   */
  it('moves the selection outside the node when switching to render', () => {
    const base = stateWith(para('before'), fence('mermaid', 'graph TD;'), para('after'));
    const pos = fencePos(base);
    const inside = apply(base, base.tr.setSelection(TextSelection.create(base.doc, pos + 2)));

    const state = apply(inside, fenceModeTransaction(inside, pos, 'render')!);
    const node = state.doc.nodeAt(pos)!;
    const { from } = state.selection;

    expect(from > pos && from < pos + node.nodeSize).toBe(false);
    expect(modeAt(state, pos)).toBe('render');
  });

  it('places the selection inside the source when switching to code', () => {
    const base = stateWith(para('before'), fence('mermaid', 'graph TD;'));
    const pos = fencePos(base);
    const state = apply(base, fenceModeTransaction(base, pos, 'code')!);
    const node = state.doc.nodeAt(pos)!;
    const { from } = state.selection;

    expect(from > pos && from < pos + node.nodeSize).toBe(true);
    expect(modeAt(state, pos)).toBe('code');
  });

  it('returns null for a position that is not a code block', () => {
    const state = stateWith(para('before'), fence('mermaid', 'graph TD;'));
    expect(fenceModeTransaction(state, 0, 'code')).toBeNull();
  });
});

describe('fenceModeFromDecorations', () => {
  it('defaults to render when no decoration carries a mode', () => {
    expect(fenceModeFromDecorations([])).toBe('render');
  });
});

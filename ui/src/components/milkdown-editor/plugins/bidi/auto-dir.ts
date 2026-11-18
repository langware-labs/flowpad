/**
 * Base direction for paragraphs and headings that carry no explicit `dir`.
 *
 * Same rule as the read-only markdown view (`lib/text-direction.ts`): the
 * script that owns more of the block's WORDS wins, the UI locale breaks ties,
 * and inline code does not vote. `dir="auto"` read only the first strong
 * character, so a Hebrew bullet opening with `Hub:` rendered LTR.
 *
 * Applied as node decorations, recomputed on every doc change — `toDOM` only
 * runs when a node's markup changes, so a dir baked there would go stale while
 * typing. An explicit `dir` attr (a `<p dir>` wrapper) is left alone.
 */

import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import type { Node as PMNode } from '@milkdown/prose/model';

import { directionOfText, type TextDirection } from '@src/lib/text-direction';

const AUTO_DIR_TYPES: ReadonlySet<string> = new Set(['paragraph', 'heading']);

/** The block's prose text, without inline code. */
function proseText(block: PMNode): string {
  let out = '';
  block.descendants((child) => {
    if (child.isText && !child.marks.some((m) => m.type.name === 'inlineCode')) out += child.text;
    out += ' ';
    return true;
  });
  return out;
}

function localeDir(): TextDirection {
  return typeof document !== 'undefined' && document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr';
}

function buildDecorations(doc: PMNode): DecorationSet {
  const tiebreak = localeDir();
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!AUTO_DIR_TYPES.has(node.type.name)) return true;
    if (!node.attrs.dir) {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { dir: directionOfText(proseText(node), tiebreak) }));
    }
    return false;
  });
  return DecorationSet.create(doc, decos);
}

const autoDirKey = new PluginKey<DecorationSet>('bidi-auto-dir');

export const bidiAutoDirPlugin = $prose(
  () =>
    new Plugin<DecorationSet>({
      key: autoDirKey,
      state: {
        init: (_, state) => buildDecorations(state.doc),
        apply: (tr, prev) => (tr.docChanged ? buildDecorations(tr.doc) : prev),
      },
      props: {
        decorations: (state) => autoDirKey.getState(state),
      },
    }),
);

/**
 * Milkdown plugin for <plan-note> marks.
 *
 * - Defines a `planNote` mark in the ProseMirror schema.
 * - Parses <plan-note>…</plan-note> from markdown (remark plugin).
 * - Serializes the mark back to <plan-note>…</plan-note> in markdown output.
 * - Auto-applies the mark to all user-typed text via an appendTransaction plugin.
 */

import { $markSchema, $prose } from '@milkdown/utils';
import { remarkPluginsCtx, remarkStringifyOptionsCtx } from '@milkdown/core';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { MilkdownPlugin } from '@milkdown/ctx';
import type { MarkdownNode, RemarkPlugin } from '@milkdown/transformer';

/* ------------------------------------------------------------------ */
/*  1. Mark schema                                                     */
/* ------------------------------------------------------------------ */

export const planNoteSchema = $markSchema('planNote', () => ({
  // ProseMirror DOM handling (paste / render)
  parseDOM: [{ tag: 'plan-note' }],
  toDOM: () => ['plan-note', 0] as const,

  // Markdown → ProseMirror
  parseMarkdown: {
    match: (node: MarkdownNode) => node.type === 'planNote',
    runner: (state, node, markType) => {
      state.openMark(markType);
      state.next(node.children);
      state.closeMark(markType);
    },
  },

  // ProseMirror → Markdown (MDAST)
  toMarkdown: {
    match: (mark) => mark.type.name === 'planNote',
    runner: (state, mark) => {
      state.withMark(mark, 'planNote');
    },
  },
}));

/* ------------------------------------------------------------------ */
/*  2. Remark parse plugin – converts <plan-note> HTML pairs in the   */
/*     MDAST into planNote nodes that our mark parser recognises.      */
/* ------------------------------------------------------------------ */

/** @internal exported for testing */
export function transformPlanNoteChildren(children: MarkdownNode[]): MarkdownNode[] {
  const result: MarkdownNode[] = [];
  let i = 0;

  while (i < children.length) {
    const child = children[i];

    // Recurse into nodes that have children (paragraphs, list items, etc.)
    if (child.children && child.type !== 'html') {
      child.children = transformPlanNoteChildren(child.children);
      result.push(child);
      i++;
      continue;
    }

    // Match opening <plan-note> tag
    if (child.type === 'html' && typeof child.value === 'string' && child.value.trim() === '<plan-note>') {
      const noteChildren: MarkdownNode[] = [];
      i++; // skip opening tag
      while (i < children.length) {
        const inner = children[i];
        if (inner.type === 'html' && typeof inner.value === 'string' && inner.value.trim() === '</plan-note>') {
          i++; // skip closing tag
          break;
        }
        noteChildren.push(inner);
        i++;
      }
      result.push({
        type: 'planNote',
        children: noteChildren,
      } as MarkdownNode);
      continue;
    }

    result.push(child);
    i++;
  }
  return result;
}

/** @internal exported for testing */
export function remarkPlanNote() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tree: any) => {
    if (tree.children) {
      tree.children = transformPlanNoteChildren(tree.children);
    }
  };
}

/* ------------------------------------------------------------------ */
/*  3. Remark stringify handler – turns planNote MDAST nodes back into */
/*     <plan-note>…</plan-note> in the markdown string.               */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function planNoteStringifyHandler(node: any, _parent: any, state: any, info: any) {
  const tracker = state.createTracker(info);
  let value = tracker.move('<plan-note>');
  value += tracker.move(
    state.containerPhrasing(node, {
      before: value,
      after: '</plan-note>',
      ...tracker.current(),
    }),
  );
  value += tracker.move('</plan-note>');
  return value;
}

/* ------------------------------------------------------------------ */
/*  4. ProseMirror plugin – auto-apply planNote mark on every         */
/*     user text input so typed text appears red immediately.          */
/* ------------------------------------------------------------------ */

const planNoteAutoApplyKey = new PluginKey('planNoteAutoApply');

const planNoteAutoApplyPlugin = $prose((ctx) => {
  const markType = planNoteSchema.type(ctx);
  return new Plugin({
    key: planNoteAutoApplyKey,
    appendTransaction(transactions, _oldState, newState) {
      // Only act on transactions that changed the document from user input
      const userChanged = transactions.some((tr) => tr.docChanged && !tr.getMeta('remote'));
      if (!userChanged) return null;

      const { tr } = newState;
      let modified = false;

      // Walk every text node; if it lacks our mark and is in a range that changed, add it
      newState.doc.descendants((node, pos) => {
        if (!node.isText) return;
        if (markType.isInSet(node.marks)) return; // already marked

        // Check if this text position overlaps with any changed range
        const nodeEnd = pos + node.nodeSize;
        for (const transaction of transactions) {
          if (!transaction.docChanged) continue;
          for (const map of transaction.mapping.maps) {
            map.forEach((oldStart: number, oldEnd: number, newStart: number, newEnd: number) => {
              void oldStart; void oldEnd;
              // The mapped range in the new doc that was affected
              if (pos < newEnd && nodeEnd > newStart) {
                // Only mark the intersection of the changed range and this text node
                const from = Math.max(pos, newStart);
                const to = Math.min(nodeEnd, newEnd);
                if (from < to) {
                  tr.addMark(from, to, markType.create());
                  modified = true;
                }
              }
            });
          }
        }
      });

      return modified ? tr : null;
    },
  });
});

/* ------------------------------------------------------------------ */
/*  5. Registration plugin – wires the remark parse + stringify into  */
/*     Milkdown's context before the editor initialises.              */
/* ------------------------------------------------------------------ */

const planNoteRemarkPlugin: MilkdownPlugin = (ctx) => () => {
  // Add remark parse plugin
  const plugin: RemarkPlugin = { plugin: remarkPlanNote as RemarkPlugin['plugin'], options: {} };
  ctx.update(remarkPluginsCtx, (prev) => [...prev, plugin]);

  // Add stringify handler for planNote MDAST nodes
  ctx.update(remarkStringifyOptionsCtx, (prev: Record<string, unknown>) => ({
    ...prev,
    handlers: {
      ...(prev.handlers as Record<string, unknown> | undefined),
      planNote: planNoteStringifyHandler,
    },
  }));
};

/* ------------------------------------------------------------------ */
/*  Public export – use with editor.use(planNotePlugins)               */
/* ------------------------------------------------------------------ */

export const planNotePlugins: MilkdownPlugin[] = [
  planNoteRemarkPlugin,
  ...planNoteSchema,
  planNoteAutoApplyPlugin,
];

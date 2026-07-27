/**
 * Schema extension for per-block `dir` / `align` on paragraph.
 *
 * Round-trip storage: a blank-line-wrapped ``<p dir="rtl">…</p>`` HTML block;
 * ``bidi/parser.ts`` collapses the opening/closing pair into attrs on
 * ``node.data.bidi``. With no attrs set, output is byte-identical to plain
 * commonmark (no wrapper, no stray whitespace).
 *
 * **Heading is intentionally NOT extended.** A Milkdown bug in
 * ``@milkdown/utils`` makes two ``$nodeSchema`` / ``extendSchema`` overrides
 * on commonmark base nodes (paragraph + heading) coexist incorrectly — the
 * resulting ProseMirror schema sends ``_NodeType.createAndFill`` /
 * ``_ContentMatch.fillBefore`` into infinite recursion at editor mount,
 * crashing every editor in the app with ``RangeError: Maximum call stack
 * size exceeded``. Each override alone is fine; both together always crash,
 * regardless of order, even for verbatim plain redefines.
 *
 * Workaround until upstream is fixed: extend paragraph only. Headings still
 * render in the correct direction because CSS ``direction`` inherits from
 * any RTL paragraph/container above them; an ``<h1 dir>`` that needs to be
 * different from the surrounding paragraph is not supported until the
 * Milkdown bug is resolved.
 */

import { paragraphSchema, paragraphAttr } from '@milkdown/preset-commonmark';
import { editorViewCtx } from '@milkdown/core';
import type { MilkdownPlugin } from '@milkdown/ctx';
import type { Node as PMNode } from '@milkdown/prose/model';

import { type BidiDir, type BidiAlign, normalizeDir, normalizeAlign, parseAlignFromStyle } from './normalize';

function buildBidiDomAttrs(node: PMNode): Record<string, string> {
  const out: Record<string, string> = {};
  const dir = normalizeDir(node.attrs.dir);
  const align = normalizeAlign(node.attrs.align);
  // No explicit override ⇒ dir="auto": base direction follows the paragraph's
  // first strong character instead of the app UI locale, so RTL content
  // renders RTL in an LTR-locale app. Render-time only — `normalizeDir`
  // rejects "auto", so parseDOM reads it back as null and `hasBidiOverride`
  // stays false (markdown output remains unwrapped CommonMark).
  out.dir = dir ?? 'auto';
  if (align) out.style = `text-align: ${align}`;
  return out;
}

/** Both attrs at default ⇒ no HTML wrapper, no behavioral change. */
function hasBidiOverride(node: PMNode): boolean {
  return normalizeDir(node.attrs.dir) !== null || normalizeAlign(node.attrs.align) !== null;
}

function buildOpeningTag(tag: string, node: PMNode): string {
  const parts: string[] = [];
  const dir = normalizeDir(node.attrs.dir);
  const align = normalizeAlign(node.attrs.align);
  if (dir) parts.push(`dir="${dir}"`);
  if (align) parts.push(`style="text-align: ${align}"`);
  return `<${tag}${parts.length ? ' ' + parts.join(' ') : ''}>`;
}

// ── paragraph ────────────────────────────────────────────────────────────────

export const bidiParagraphSchema = paragraphSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: {
      ...(base.attrs ?? {}),
      dir: { default: null },
      align: { default: null },
    },
    parseDOM: (base.parseDOM ?? [{ tag: 'p' }]).map((rule) => ({
      ...rule,
      getAttrs: (dom: unknown) => {
        const prevAttrs =
          typeof rule.getAttrs === 'function' ? rule.getAttrs(dom as HTMLElement) || {} : { ...(rule.attrs ?? {}) };
        if (!(dom instanceof HTMLElement)) return prevAttrs as Record<string, unknown>;
        return {
          ...prevAttrs,
          dir: normalizeDir(dom.getAttribute('dir')),
          align: parseAlignFromStyle(dom.getAttribute('style')),
        };
      },
    })),
    toDOM: (node) => {
      const baseAttrs = ctx.get(paragraphAttr.key)(node);
      return ['p', { ...baseAttrs, ...buildBidiDomAttrs(node) }, 0];
    },
    parseMarkdown: {
      match: (mdNode) => mdNode.type === 'paragraph',
      runner: (state, mdNode, type) => {
        const bidi = (mdNode as { data?: { bidi?: { dir?: BidiDir; align?: BidiAlign } } }).data?.bidi;
        const attrs = bidi ? { dir: normalizeDir(bidi.dir), align: normalizeAlign(bidi.align) } : {};
        state.openNode(type, attrs);
        if (mdNode.children) state.next(mdNode.children);
        else if (typeof mdNode.value === 'string') state.addText(mdNode.value);
        state.closeNode();
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === 'paragraph',
      runner: (state, node) => {
        if (!hasBidiOverride(node)) {
          // Fall through to the original commonmark path — byte-identical
          // output for the default case is required (no HTML wrapper, no
          // stray whitespace introduced by this plugin).
          //
          // `editorViewCtx` is only present once the view is attached.
          // Serialization can run before mount / after teardown (e.g. an init
          // or unmount-time getMarkdown), and `ctx.get` THROWS when the slice
          // isn't injected — "Context editorView not found", once per paragraph,
          // flooding the console with uncaught MilkdownErrors. Guard with
          // `isInjected`: with no live view, treat the node as not-last (the
          // empty-paragraph `<br />` heuristic only matters in the live editor).
          const view = ctx.isInjected(editorViewCtx) ? ctx.get(editorViewCtx) : null;
          const isLastBlock = view ? view.state?.doc.lastChild === node : false;
          state.openNode('paragraph');
          if ((!node.content || node.content.size === 0) && !isLastBlock) {
            state.addNode('html', undefined, '<br />');
          } else {
            state.next(node.content);
          }
          state.closeNode();
          return;
        }
        // Override path: emit opening tag, body as a real paragraph (so
        // inline markdown is preserved on the next parse), then closing tag.
        // CommonMark requires blank lines around HTML blocks for the inner
        // content to be parsed as markdown rather than swallowed.
        state.addNode('html', undefined, buildOpeningTag('p', node));
        state.openNode('paragraph');
        state.next(node.content);
        state.closeNode();
        state.addNode('html', undefined, '</p>');
      },
    },
  };
});

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Spread into the editor's plugin list AFTER the commonmark preset.
 * The remark transformer (see ``parser.ts``) must also be registered or the
 * ``<p dir="...">`` opening/closing tags in source markdown will round-trip
 * as raw HTML blocks instead of attrs on paragraph nodes.
 *
 * Heading override is omitted — see file header for the Milkdown bug that
 * forces this workaround.
 */
export const bidiSchemaPlugins: MilkdownPlugin[] = [...bidiParagraphSchema];

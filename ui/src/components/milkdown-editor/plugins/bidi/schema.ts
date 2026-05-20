/**
 * Schema extensions for per-block `dir` / `align` on paragraph + heading.
 * Round-trip storage: a blank-line-wrapped `<p dir="rtl">…</p>` HTML block;
 * `bidi/parser.ts` collapses the opening/closing pair into attrs on
 * `node.data.bidi`. With no attrs set, output is byte-identical to plain
 * commonmark (no wrapper, no stray whitespace).
 */

import { paragraphSchema, paragraphAttr, headingSchema } from '@milkdown/preset-commonmark';
import { editorViewCtx } from '@milkdown/core';
import type { MilkdownPlugin } from '@milkdown/ctx';
import type { Node as PMNode } from '@milkdown/prose/model';

import { type BidiDir, type BidiAlign, normalizeDir, normalizeAlign, parseAlignFromStyle } from './normalize';

function buildBidiDomAttrs(node: PMNode): Record<string, string> {
  const out: Record<string, string> = {};
  const dir = normalizeDir(node.attrs.dir);
  const align = normalizeAlign(node.attrs.align);
  if (dir) out.dir = dir;
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
          typeof rule.getAttrs === 'function'
            ? rule.getAttrs(dom as HTMLElement) || {}
            : { ...(rule.attrs ?? {}) };
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
        const attrs = bidi
          ? { dir: normalizeDir(bidi.dir), align: normalizeAlign(bidi.align) }
          : {};
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
          const view = ctx.get(editorViewCtx);
          const isLastBlock = view.state?.doc.lastChild === node;
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

// ── heading ──────────────────────────────────────────────────────────────────

export const bidiHeadingSchema = headingSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: {
      ...(base.attrs ?? {}),
      dir: { default: null },
      align: { default: null },
    },
    parseDOM: (base.parseDOM ?? []).map((rule) => ({
      ...rule,
      getAttrs: (dom: unknown) => {
        const prevAttrs =
          typeof rule.getAttrs === 'function'
            ? rule.getAttrs(dom as HTMLElement) || {}
            : { ...(rule.attrs ?? {}) };
        if (!(dom instanceof HTMLElement)) return prevAttrs as Record<string, unknown>;
        return {
          ...prevAttrs,
          dir: normalizeDir(dom.getAttribute('dir')),
          align: parseAlignFromStyle(dom.getAttribute('style')),
        };
      },
    })),
    toDOM: (node) => {
      // Call the original toDOM to preserve the id/heading-id generator
      // contract, then layer bidi attrs on top of its attribute object.
      const original = base.toDOM!(node) as [string, Record<string, string>, 0];
      const [tag, attrs, hole] = original;
      return [tag, { ...attrs, ...buildBidiDomAttrs(node) }, hole];
    },
    parseMarkdown: {
      match: ({ type }) => type === 'heading',
      runner: (state, mdNode, type) => {
        const depth = (mdNode as { depth?: number }).depth ?? 1;
        const bidi = (mdNode as { data?: { bidi?: { dir?: BidiDir; align?: BidiAlign } } }).data?.bidi;
        const extra = bidi
          ? { dir: normalizeDir(bidi.dir), align: normalizeAlign(bidi.align) }
          : {};
        state.openNode(type, { level: depth, ...extra });
        if (mdNode.children) state.next(mdNode.children);
        state.closeNode();
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === 'heading',
      runner: (state, node) => {
        if (!hasBidiOverride(node)) {
          // Default path — preserve the original commonmark behavior verbatim.
          state.openNode('heading', undefined, { depth: node.attrs.level });
          state.next(node.content);
          state.closeNode();
          return;
        }
        const level = Number(node.attrs.level) || 1;
        state.addNode('html', undefined, buildOpeningTag(`h${level}`, node));
        state.openNode('heading', undefined, { depth: level });
        state.next(node.content);
        state.closeNode();
        state.addNode('html', undefined, `</h${level}>`);
      },
    },
  };
});

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Spread into the editor's plugin list AFTER the commonmark preset.
 * The remark transformer (see `parser.ts`) must also be registered or the
 * `<p dir="...">` opening/closing tags in source markdown will round-trip
 * as raw HTML blocks instead of attrs on paragraph/heading nodes.
 */
export const bidiSchemaPlugins: MilkdownPlugin[] = [
  ...bidiParagraphSchema,
  ...bidiHeadingSchema,
];

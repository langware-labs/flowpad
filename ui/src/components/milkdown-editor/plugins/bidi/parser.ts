/**
 * Remark transformer that lifts `<p dir>` / `<h* dir>` HTML wrappers into
 * MDAST nodes with attrs on `node.data.bidi`. Two source shapes are recognized:
 * blank-line-wrapped (emitted form) and inline `<p ...>x</p>`. Inline-form
 * inner markdown is NOT re-parsed — users get blank-line form on next save.
 */

import { remarkPluginsCtx } from '@milkdown/core';
import type { MilkdownPlugin } from '@milkdown/ctx';
import type { MarkdownNode, RemarkPlugin } from '@milkdown/transformer';

import { type BidiDir, type BidiAlign, normalizeDir, parseAlignFromStyle } from './normalize';

type BidiTag = 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

interface ParsedOpeningTag {
  tag: BidiTag;
  dir: BidiDir;
  align: BidiAlign;
}

/** Match `<p dir="..." style="...">`-style opening tags. Returns null on no match. */
function parseOpeningTag(html: string): ParsedOpeningTag | null {
  const match = /^<(p|h[1-6])\b([^>]*)>$/i.exec(html.trim());
  if (!match) return null;
  const tag = match[1].toLowerCase() as BidiTag;
  const attrsStr = match[2];
  const dir = normalizeDir(/\bdir\s*=\s*"([^"]*)"/i.exec(attrsStr)?.[1]);
  const align = parseAlignFromStyle(/\bstyle\s*=\s*"([^"]*)"/i.exec(attrsStr)?.[1]);
  if (!dir && !align) return null; // not a bidi wrapper — leave the raw html alone
  return { tag, dir, align };
}

function parseClosingTag(html: string): BidiTag | null {
  const match = /^<\/(p|h[1-6])\s*>$/i.exec(html.trim());
  return match ? (match[1].toLowerCase() as BidiTag) : null;
}

/** Inline form: `<p dir="rtl">CONTENT</p>` collapsed to a single MDAST html node. */
function parseInlineForm(html: string): { tag: BidiTag; dir: BidiDir; align: BidiAlign; inner: string } | null {
  const match = /^<(p|h[1-6])\b([^>]*)>([\s\S]*?)<\/\1\s*>$/i.exec(html.trim());
  if (!match) return null;
  const tag = match[1].toLowerCase() as BidiTag;
  const attrsStr = match[2];
  const inner = match[3];
  const dir = normalizeDir(/\bdir\s*=\s*"([^"]*)"/i.exec(attrsStr)?.[1]);
  const align = parseAlignFromStyle(/\bstyle\s*=\s*"([^"]*)"/i.exec(attrsStr)?.[1]);
  if (!dir && !align) return null;
  return { tag, dir, align, inner };
}

function makeBidiNode(
  tag: BidiTag,
  dir: BidiDir,
  align: BidiAlign,
  children: MarkdownNode[],
): MarkdownNode {
  const base = tag === 'p'
    ? { type: 'paragraph', children }
    : { type: 'heading', depth: Number(tag[1]), children };
  return {
    ...base,
    data: { bidi: { dir, align } },
  } as unknown as MarkdownNode;
}

/** @internal exported for testing */
export function transformBidiChildren(children: MarkdownNode[]): MarkdownNode[] {
  const result: MarkdownNode[] = [];
  let i = 0;

  while (i < children.length) {
    const child = children[i];

    // Inline form: a single html block holding the whole tag pair.
    if (child.type === 'html' && typeof child.value === 'string') {
      const inline = parseInlineForm(child.value);
      if (inline) {
        result.push(
          makeBidiNode(inline.tag, inline.dir, inline.align, [
            { type: 'text', value: inline.inner } as MarkdownNode,
          ]),
        );
        i++;
        continue;
      }

      // Blank-line-wrapped form: opening html + intervening sibling(s) + closing html.
      const opening = parseOpeningTag(child.value);
      if (opening) {
        // Scan forward for the matching closing tag.
        let j = i + 1;
        let closeIdx = -1;
        while (j < children.length) {
          const peek = children[j];
          if (peek.type === 'html' && typeof peek.value === 'string' && parseClosingTag(peek.value) === opening.tag) {
            closeIdx = j;
            break;
          }
          j++;
        }
        if (closeIdx !== -1) {
          const between = children.slice(i + 1, closeIdx);
          // If the wrapper holds a single paragraph, inline its children — avoids
          // `paragraph > paragraph`. Anything else (e.g. a list inside `<p>`) is
          // unwrapped at the same level to avoid silent data loss.
          const single = between.length === 1 && between[0].type === 'paragraph' && Array.isArray(between[0].children)
            ? between[0].children
            : null;
          if (!single) {
            result.push(...between);
            i = closeIdx + 1;
            continue;
          }
          result.push(makeBidiNode(opening.tag, opening.dir, opening.align, single));
          i = closeIdx + 1;
          continue;
        }
      }
    }

    // Recurse into nodes that own children but aren't html themselves.
    if (child.children && child.type !== 'html') {
      (child as MarkdownNode & { children: MarkdownNode[] }).children = transformBidiChildren(child.children);
    }
    result.push(child);
    i++;
  }
  return result;
}

/** @internal exported for testing */
export function remarkBidi() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tree: any) => {
    if (Array.isArray(tree.children)) {
      tree.children = transformBidiChildren(tree.children);
    }
  };
}

/** MilkdownPlugin registering the remark transformer. */
export const bidiRemarkPlugin: MilkdownPlugin = (ctx) => () => {
  const plugin: RemarkPlugin = { plugin: remarkBidi as RemarkPlugin['plugin'], options: {} };
  ctx.update(remarkPluginsCtx, (prev) => [...prev, plugin]);
};

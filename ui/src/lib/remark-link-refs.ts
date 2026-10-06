/**
 * Detection for rendered markdown: the file references `link-matches.ts` finds in
 * plain text become markdown links, so one `a` renderer handles them alongside
 * authored `[a](b)` links and the URLs `remark-gfm` already linked.
 *
 * - **text** — every `fileLinkMatches` hit is cut out into a link. Web URLs are
 *   `remark-gfm`'s (run it first); text already inside a link is left alone.
 * - **inline code** — `` `ui/src/a.ts:42` `` links when the WHOLE span is one
 *   reference; the code styling stays as the link's child. A span that merely
 *   contains a path (`` `cat a/b.txt` ``) is a command, not a link.
 *
 * Pure: it only reshapes the tree. What a click does is not decided here.
 */
import type { InlineCode, Link, Parent, PhrasingContent, Root, Text } from 'mdast';
import { fileLinkMatches, linkMatches } from './link-matches';

const NOT_INTO = new Set(['link', 'linkReference', 'definition']);

function link(url: string, child: PhrasingContent): Link {
  return { type: 'link', url, children: [child] };
}

function splitText(node: Text): PhrasingContent[] | null {
  const matches = fileLinkMatches(node.value);
  if (matches.length === 0) return null;
  const out: PhrasingContent[] = [];
  let at = 0;
  for (const match of matches) {
    if (match.index > at) out.push({ type: 'text', value: node.value.slice(at, match.index) });
    out.push(link(match.text, { type: 'text', value: match.text }));
    at = match.index + match.text.length;
  }
  if (at < node.value.length) out.push({ type: 'text', value: node.value.slice(at) });
  return out;
}

function wrapCode(node: InlineCode): Link | null {
  const value = node.value.trim();
  const [only, ...rest] = linkMatches(value);
  return only && rest.length === 0 && only.text === value ? link(only.text, node) : null;
}

function walk(parent: Parent): void {
  const children: Parent['children'] = [];
  for (const child of parent.children) {
    if (child.type === 'text') {
      const parts = splitText(child);
      if (parts) {
        children.push(...parts);
        continue;
      }
    } else if (child.type === 'inlineCode') {
      const wrapped = wrapCode(child);
      if (wrapped) {
        children.push(wrapped);
        continue;
      }
    } else if ('children' in child && !NOT_INTO.has(child.type)) {
      walk(child);
    }
    children.push(child);
  }
  parent.children = children;
}

export default function remarkLinkRefs() {
  return (tree: Root) => walk(tree);
}

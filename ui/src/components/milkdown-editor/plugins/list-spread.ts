/**
 * Keeps tight lists tight when the editor saves markdown.
 *
 * Milkdown's commonmark preset stores a list's `spread` attr as the STRING "true"/"false"
 * and hands it back to remark as-is, so a tight list's "false" reads as truthy and every list
 * is written loose (a blank line between items). The serializer also defaults to `*` bullets.
 * Together they rewrote a whole file on a one-word edit. This sets `-` bullets and turns the
 * string back into a boolean before the standard list handlers run.
 */
import { defaultHandlers, type Handle } from 'mdast-util-to-markdown';
import type { Options } from 'remark-stringify';

type Spreadable = { spread?: unknown; children?: Spreadable[] };

const asBool = (v: unknown) => v === true || v === 'true';

function tighten(node: Spreadable) {
  node.spread = asBool(node.spread);
  for (const child of node.children ?? []) if ('spread' in child) child.spread = asBool(child.spread);
}

/** For `ctx.update(remarkStringifyOptionsCtx, tightLists)` inside the editor's `.config()` (before init reads it). */
const tightened = (name: 'list' | 'listItem'): Handle =>
  ((node, parent, state, info) => {
    tighten(node as Spreadable);
    return defaultHandlers[name](node, parent, state, info);
  }) as Handle;

/** For `ctx.update(remarkStringifyOptionsCtx, tightLists)` inside the editor's `.config()` (before init reads it). */
export function tightLists(prev: Options): Options {
  return {
    ...prev,
    bullet: '-',
    handlers: { ...prev.handlers, list: tightened('list'), listItem: tightened('listItem') },
  };
}

/**
 * Keeps tight lists tight when the editor saves markdown.
 *
 * Milkdown's commonmark preset stores a list's `spread` attr as the STRING "true"/"false"
 * and hands it back to remark as-is, so a tight list's "false" reads as truthy and every list
 * is written loose (a blank line between items). The serializer also defaults to `*` bullets.
 * Together they rewrote a whole file on a one-word edit. This keeps the source's bullet marker and turns the
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

type Bullet = NonNullable<Options['bullet']>;

/** The bullet marker the source's first bullet item uses (fenced code skipped); `-` when it has none. */
export function sourceBullet(markdown: string): Bullet {
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open) {
      if (fence === null) fence = open[1][0];
      else if (open[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const item = /^\s*([-*+])\s+\S/.exec(line);
    // `* * *` / `- - -` is a thematic break, not a list.
    if (item && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return item[1] as Bullet;
  }
  return '-';
}

/** For `ctx.update(remarkStringifyOptionsCtx, (p) => tightLists(p, sourceBullet(md)))` inside the editor's `.config()`. */
export function tightLists(prev: Options, bullet: Bullet = '-'): Options {
  return {
    ...prev,
    bullet,
    handlers: { ...prev.handlers, list: tightened('list'), listItem: tightened('listItem') },
  };
}

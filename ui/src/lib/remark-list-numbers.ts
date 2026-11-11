/**
 * Keeps the number the author typed on each ordered-list item. CommonMark only keeps
 * the first item's number and counts on from it, so `3.` then `5.` renders as 3, 4 —
 * wrong when the numbers refer back to earlier points. Each item's marker is read from
 * the source and set as the `<li value>`.
 */
import type { List, Root } from 'mdast';
import type { VFile } from 'vfile';

function visitLists(node: Root | List | Root['children'][number], src: string): void {
  if (node.type === 'list' && node.ordered) {
    for (const item of node.children) {
      const offset = item.position?.start.offset;
      const number = offset === undefined ? null : /^\d+/.exec(src.slice(offset));
      if (number) item.data = { ...item.data, hProperties: { ...item.data?.hProperties, value: Number(number[0]) } };
    }
  }
  if ('children' in node) for (const child of node.children) visitLists(child as Root['children'][number], src);
}

export default function remarkListNumbers() {
  return (tree: Root, file: VFile) => visitLists(tree, String(file.value));
}

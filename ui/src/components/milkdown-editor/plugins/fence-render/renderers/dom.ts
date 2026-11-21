/**
 * The small DOM primitives every fence renderer needs.
 *
 * Renderers build plain DOM — one React root per fence, mounted and unmounted
 * by a ProseMirror NodeView, is a lifecycle hazard for cards this static — so
 * they all want the same few things: an element factory, lucide icons as
 * markup, and a click-to-edit value.
 *
 * Icons go through `renderToStaticMarkup` rather than transcribed path data.
 * Hand-copying lucide paths drifts: the first version of the interface card's
 * icon constant was already a stale revision of `file-code`. This is the same
 * escape hatch `graph-view/icons/iconToDataUri.ts` uses to get a lucide icon
 * outside a React tree.
 */

import type { LucideIcon } from 'lucide-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TagChip } from '@src/components/tags/tag-chip';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const tagChips = new Map<string, string>();

/** The app's tag chip for `name`, as markup. Kept per name: a doc draws one per block. */
export function tagChipMarkup(name: string): string {
  let markup = tagChips.get(name);
  if (markup == null) {
    markup = renderToStaticMarkup(createElement(TagChip, { name }));
    tagChips.set(name, markup);
  }
  return markup;
}

/** Markup for a decorative lucide icon. Call at module scope — it is not cheap. */
export function iconMarkup(icon: LucideIcon, size = 12): string {
  return renderToStaticMarkup(createElement(icon, { width: size, height: size, 'aria-hidden': true }));
}

/**
 * A click-to-edit value.
 *
 * `contenteditable` on a descendant of the (non-editable) preview pane creates
 * an editable island the host editor ignores — the NodeView's `stopEvent` and
 * `ignoreMutation` keep ProseMirror out of this subtree entirely, so typing
 * here never reaches the outer document.
 *
 * Enter commits, Escape reverts, blur commits. An edit that doesn't change
 * anything commits nothing. Select-all selects the field, not the document.
 */
export function editable(
  className: string,
  value: string,
  testId: string,
  canEdit: boolean,
  onCommit: (next: string) => void,
): HTMLElement {
  // Read-only host (the vibe display, any `view` mode asset): draw the value as
  // plain text. The controls sit in a `contenteditable="false"` pane, outside
  // ProseMirror's own editable check, so nothing else would stop a user from
  // editing a document they are only meant to be reading.
  if (!canEdit) {
    const readonly = el('span', className, value);
    readonly.setAttribute('data-testid', testId);
    return readonly;
  }

  const node = el('span', `${className} fence-editable`, value);
  // setAttribute, not the `contentEditable` IDL property: the property does not
  // reflect to the attribute in jsdom, so component tests could not observe it.
  node.setAttribute('contenteditable', 'true');
  node.spellcheck = false;
  node.setAttribute('role', 'textbox');
  node.setAttribute('data-testid', testId);

  const revert = () => {
    node.textContent = value;
  };

  const commit = () => {
    const next = (node.textContent ?? '').trim();
    if (!next) {
      // An emptied field would delete the key from the YAML; treat it as a
      // mistake and restore rather than silently dropping the author's data.
      revert();
      return;
    }
    if (next === value) {
      node.textContent = value; // normalize away stray whitespace
      return;
    }
    onCommit(next);
  };

  node.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      // Select-all means "all of this field". Left to the browser it selects the
      // whole document around the field and hands focus to the host editor, and
      // the next key typed replaces the document.
      event.preventDefault();
      node.ownerDocument.getSelection()?.selectAllChildren(node);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      node.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      revert();
      node.blur();
    }
  });
  node.addEventListener('blur', commit);

  return node;
}

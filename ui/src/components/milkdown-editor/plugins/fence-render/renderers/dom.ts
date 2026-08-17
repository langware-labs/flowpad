/**
 * The small DOM primitives every fence renderer needs.
 *
 * Renderers build plain DOM — one React root per fence, mounted and unmounted
 * by a ProseMirror NodeView, is a lifecycle hazard for cards this static — so
 * they all want the same two things: an element factory, and lucide icons as
 * markup.
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

/** Markup for a decorative lucide icon. Call at module scope — it is not cheap. */
export function iconMarkup(icon: LucideIcon, size = 12): string {
  return renderToStaticMarkup(createElement(icon, { width: size, height: size, 'aria-hidden': true }));
}

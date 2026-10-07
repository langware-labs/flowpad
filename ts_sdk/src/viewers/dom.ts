/** The DOM builder every viewer shares (handed to asset viewers as `ctx.h`), and one-time styles. */
import type { H } from './contract';

export const h: H = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
};

const injected = new Set<string>();

/** Add `css` to the page once per `key` — a viewer module's styles, the first time it is used. */
export function injectStyles(key: string, css: string | undefined): void {
  if (!css || injected.has(key) || typeof document === 'undefined') return;
  injected.add(key);
  const style = document.createElement('style');
  style.dataset.viewer = key;
  style.textContent = css;
  document.head.append(style);
}

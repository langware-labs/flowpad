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

/** Tooltips the page draws itself. A native `title` tooltip does not show inside an app's iframe in
 *  the desktop app (and never on touch), so the first hover over anything with a `title` moves the
 *  text to `data-tip` (no native one doubles it) and shows it in one floating box, kept on screen.
 *  Installed once per page, by the app host (`applyHostTheme`). */
export function installTooltips(): void {
  if (injected.has('tooltips') || typeof document === 'undefined') return;
  injectStyles('tooltips', TOOLTIP_STYLES);
  const box = h('div', { class: 'dv-tip', role: 'tooltip' });
  const hide = () => box.remove();
  document.addEventListener('mouseover', (event) => {
    const target = (event.target as Element | null)?.closest?.('[title], [data-tip]');
    if (target?.hasAttribute('title')) {
      target.setAttribute('data-tip', target.getAttribute('title')!);
      target.removeAttribute('title');
    }
    const text = target?.getAttribute('data-tip');
    if (!target || !text) return hide();
    box.textContent = text;
    document.body.append(box);
    const at = target.getBoundingClientRect();
    const tip = box.getBoundingClientRect();
    const below = at.bottom + 6;
    box.style.left = `${Math.max(8, Math.min(at.left, window.innerWidth - tip.width - 8))}px`;
    box.style.top = `${below + tip.height <= window.innerHeight - 8 ? below : Math.max(8, at.top - tip.height - 6)}px`;
  });
  document.addEventListener('scroll', hide, true);
  document.addEventListener('mouseleave', hide);
}

const TOOLTIP_STYLES = `
.dv-tip { position: fixed; z-index: 10000; max-width: min(360px, calc(100vw - 16px)); padding: .45rem .6rem; border-radius: 8px;
  background: hsl(var(--popover, var(--background))); color: hsl(var(--popover-foreground, var(--foreground)));
  border: 1px solid hsl(var(--border)); box-shadow: 0 6px 24px hsl(0 0% 0% / .35); font: 12px/1.45 var(--font-sans, system-ui);
  white-space: normal; pointer-events: none; }
`;

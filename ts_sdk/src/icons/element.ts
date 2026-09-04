import { getIconFallback } from './registry';
import { resolveIcon } from './resolve';
import type { IconPackSpec, IconResolution } from './types';

/**
 * Rendering an icon with no framework at all.
 *
 * Two strategies, chosen by `tintable`, and the choice is the whole point:
 *
 *  - **tintable** — a CSS mask over `background-color`. The glyph inherits
 *    `currentColor` exactly like text does, so it darkens with the paragraph
 *    around it and needs no theme-specific artwork.
 *  - **not tintable** — an `<img>`. A four-colour brand mark has colours of its
 *    own; an `<img>` cannot take the text colour around it, which is precisely
 *    why the distinction has to be recorded in the spec rather than guessed at
 *    render time.
 *
 * A `dark` variant is handled by shipping BOTH images and letting CSS pick. The
 * viewer has three theme states and only two are visible to JS — an explicit
 * choice stamps `data-theme` on the root, while the default "system" setting
 * stamps nothing and is separated from light only by `prefers-color-scheme`.
 * `ICON_CSS` covers all three, in that order of specificity — and it honours
 * BOTH conventions for an explicit choice: a `data-theme` attribute and a
 * `light`/`dark` class. The Flowpad app uses the class (`ui/src/styles/index.css`
 * defines `.dark`), and keying only off the attribute is not a cosmetic miss:
 * with an OS set to dark and the app set to light, the guard fails to match and
 * the page shows the DARK artwork on the LIGHT ground — a white mark on white.
 */

export const ICON_STYLE_ID = 'flowpad-icon-css';

/**
 * Sizing defaults are wrapped in `:where()` so they carry ZERO specificity.
 *
 * This stylesheet is injected at runtime, which puts it last in the cascade —
 * so a plain `.fp-icon{width:1em}` would beat `h-4 w-4`, `size-4` and every
 * other class the app already sizes icons with, at all ~1,600 call sites. A
 * default has to lose to anything the caller says; `:where()` is how a rule
 * says that. The painting rules below keep normal specificity: nothing in the
 * app competes with them.
 */
export const ICON_CSS = `
:where(.fp-icon){display:inline-block;width:1em;height:1em;flex:none;vertical-align:-0.125em;line-height:1}
.fp-icon-mask{background-color:currentColor;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;
  -webkit-mask-position:center;mask-position:center;-webkit-mask-size:contain;mask-size:contain}
.fp-icon-img{width:100%;height:100%;object-fit:contain;display:block}
:where(.fp-icon-text){display:inline-flex;align-items:center;justify-content:center;
  line-height:1;vertical-align:-0.125em}
.fp-icon-themed>.fp-icon-dark{display:none}
.fp-icon-themed>.fp-icon-light{display:block}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]):not(.light) .fp-icon-themed>.fp-icon-light{display:none}
  :root:not([data-theme="light"]):not(.light) .fp-icon-themed>.fp-icon-dark{display:block}
}
:root[data-theme="dark"] .fp-icon-themed>.fp-icon-light,
:root.dark .fp-icon-themed>.fp-icon-light{display:none}
:root[data-theme="dark"] .fp-icon-themed>.fp-icon-dark,
:root.dark .fp-icon-themed>.fp-icon-dark{display:block}
:root[data-theme="light"] .fp-icon-themed>.fp-icon-light,
:root.light .fp-icon-themed>.fp-icon-light{display:block}
:root[data-theme="light"] .fp-icon-themed>.fp-icon-dark,
:root.light .fp-icon-themed>.fp-icon-dark{display:none}

/* A sub-icon sits on the host's corner, on a plate so it reads against the
   artwork underneath. The plate takes the surrounding background — override
   --fp-icon-badge-bg where the icon sits on a tinted surface. */
:where(.fp-icon-stack){position:relative;display:inline-block;width:1em;height:1em;flex:none;vertical-align:-0.125em}
.fp-icon-stack{position:relative}
.fp-icon-stack>.fp-icon-base{position:absolute;inset:0;width:100%;height:100%;vertical-align:baseline}
/* The plate is its OWN element, not a class on the badge glyph. A tintable
   glyph paints itself with background-color: currentColor -- put the plate on
   the same element and the two fight over background, the plate wins on
   specificity, and the badge is painted in the plate's own colour: invisible. */
.fp-icon-stack>.fp-icon-sub{position:absolute;right:-12%;bottom:-12%;width:58%;height:58%;
  display:flex;align-items:center;justify-content:center;border-radius:50%;
  background:var(--fp-icon-badge-bg,Canvas);box-shadow:0 0 0 1.5px var(--fp-icon-badge-bg,Canvas)}
.fp-icon-stack>.fp-icon-sub>.fp-icon,
.fp-icon-stack>.fp-icon-sub>.fp-icon-stack{width:78%;height:78%;vertical-align:baseline}

/* The chip: a glyph with its name, the treatment a row is recognised BY.
   Mirrors SOURCE_CHIP in channel-attribution.tsx so both read as one language. */
.fp-chip{display:inline-flex;align-items:center;gap:4px;border-radius:4px;border:1px solid;
  padding:1px 6px 1px 4px;font-size:10px;font-weight:600;line-height:1.4;vertical-align:middle;
  border-color:var(--fp-chip-border,currentColor);background:var(--fp-chip-bg,transparent);
  color:var(--fp-chip-fg,inherit)}
.fp-chip>.fp-icon,.fp-chip>.fp-icon-stack{font-size:14px}
.fp-chip-compact{gap:2px;padding:0 4px;font-size:9px;font-weight:500}
.fp-chip-compact>.fp-icon,.fp-chip-compact>.fp-icon-stack{font-size:11px}
`;

/** Inject `ICON_CSS` once per document. Safe to call on every render. */
export function ensureIconStyles(doc: Document = document): void {
  if (doc.getElementById(ICON_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = ICON_STYLE_ID;
  style.textContent = ICON_CSS;
  doc.head.appendChild(style);
}

export interface IconElementOptions {
  /** `restore` — a role, appended to the tag as one more segment. */
  role?: string;
  /** Extra classes on the returned element. */
  className?: string;
  /** Accessible name. Omit for a decorative icon, which is the default. */
  title?: string;
  /** Override the spec's own colour. Only meaningful for a tintable glyph. */
  color?: string;
  doc?: Document;
}

/** One glyph, with no sub-icon — the shared half of `iconElementFor`. */
function leaf(res: IconResolution, opts: IconElementOptions, extraClass = ''): HTMLElement {
  const doc = opts.doc || document;
  const span = doc.createElement('span');
  span.className = ['fp-icon', extraClass, opts.className].filter(Boolean).join(' ');
  if (opts.title) {
    span.setAttribute('role', 'img');
    span.setAttribute('aria-label', opts.title);
    span.title = opts.title;
  } else {
    span.setAttribute('aria-hidden', 'true');
  }

  // The value IS the glyph — an emoji from the picker, or initials.
  if (res.kind === 'text') {
    span.classList.add('fp-icon-text');
    span.textContent = res.text;
    return span;
  }

  const url = res.kind === 'asset' || res.kind === 'path' ? res.url : res.kind === 'bundle' ? res.url : undefined;
  if (!url) return span; // `none`, or a bundle icon this backend serves no file for

  const tintable = res.kind === 'asset' || res.kind === 'bundle' ? res.tintable : false;
  const color = opts.color || ((res.kind === 'asset' || res.kind === 'bundle') && res.color) || '';
  const darkUrl = res.kind === 'asset' ? res.darkUrl : undefined;

  if (tintable) {
    span.classList.add('fp-icon-mask');
    span.style.setProperty('-webkit-mask-image', `url("${url}")`);
    span.style.setProperty('mask-image', `url("${url}")`);
    if (color) span.style.backgroundColor = color;
    return span;
  }

  const img = (src: string, cls: string) => {
    const el = doc.createElement('img');
    el.src = src;
    el.alt = '';
    el.className = `fp-icon-img ${cls}`;
    el.loading = 'lazy';
    // An icon that fails to load must leave a blank, not the browser's
    // broken-image chrome. A torn-page glyph in a toolbar reads as a bug in the
    // product rather than a missing file, and it is strictly worse than the
    // caller's own fallback. The span keeps its box, so nothing reflows.
    el.addEventListener('error', () => {
      el.remove();
      span.dataset.broken = 'true';
    });
    return el;
  };

  if (darkUrl) {
    // Both artworks ship; CSS decides. See ICON_CSS for the three-state rule.
    span.classList.add('fp-icon-themed');
    span.appendChild(img(url, 'fp-icon-light'));
    span.appendChild(img(darkUrl, 'fp-icon-dark'));
  } else {
    span.appendChild(img(url, ''));
  }
  return span;
}

/** Build the DOM for an already-resolved icon, sub-icon and all. */
export function iconElementFor(res: IconResolution, opts: IconElementOptions = {}): HTMLElement {
  const doc = opts.doc || document;
  const badge = (res.kind === 'asset' || res.kind === 'bundle') && res.badge ? res.badge : undefined;
  if (!badge) return leaf(res, opts);

  // Composed: the host glyph, plus a smaller one on its corner. The stack owns
  // the sizing and the accessible name; the two layers inside are decoration.
  const stack = doc.createElement('span');
  stack.className = ['fp-icon-stack', opts.className].filter(Boolean).join(' ');
  if (opts.title) {
    stack.setAttribute('role', 'img');
    stack.setAttribute('aria-label', opts.title);
    stack.title = opts.title;
  } else {
    stack.setAttribute('aria-hidden', 'true');
  }
  const inner = { ...opts, className: undefined, title: undefined, doc };
  stack.appendChild(leaf(res, inner, 'fp-icon-base'));

  const plate = doc.createElement('span');
  plate.className = 'fp-icon-sub';
  plate.setAttribute('aria-hidden', 'true');
  plate.appendChild(leaf(badge, { ...inner, color: undefined }));
  stack.appendChild(plate);
  return stack;
}

export interface IconChipOptions extends IconElementOptions {
  /** The tighter treatment used for category chips. */
  compact?: boolean;
}

/**
 * A glyph with its name, as a chip — the treatment an inbox row is recognised
 * by (`SourceChip` in `channel-attribution.tsx`).
 *
 * It is here rather than in a component because the chip is where the icon
 * system is actually judged: at 14px beside 10px text, on a muted plate, is
 * where a wrong glyph or an untinted brand mark is obvious. Colours come from
 * `--fp-chip-bg` / `--fp-chip-fg` / `--fp-chip-border` so a host dresses it in
 * its own tokens instead of the SDK guessing a palette.
 */
export function iconChip(
  ref: string | null | undefined,
  label: string,
  packs: IconPackSpec[],
  opts: IconChipOptions = {},
): HTMLElement {
  const doc = opts.doc || document;
  ensureIconStyles(doc);
  const chip = doc.createElement('span');
  chip.className = ['fp-chip', opts.compact ? 'fp-chip-compact' : '', opts.className]
    .filter(Boolean)
    .join(' ');
  chip.title = label;
  chip.appendChild(
    iconElementFor(resolveForRender(ref, packs, opts.role), {
      ...opts,
      className: undefined,
      doc,
    }),
  );
  chip.appendChild(doc.createTextNode(label));
  return chip;
}

/** A tag plus an optional role — the ONE place that join is spelled. */
export function withRole(ref: string | null | undefined, role?: string): string | null | undefined {
  return ref && role ? `${ref}.${role}` : ref;
}

/**
 * Resolve, applying the unknown-icon fallback — the one call a plain page needs.
 *
 * `resolveIcon` stays honest and answers `none`, because a caller inspecting a
 * resolution needs to know. Rendering is where the fallback belongs.
 */
export function resolveForRender(
  ref: string | null | undefined,
  packs: IconPackSpec[],
  role?: string,
): IconResolution {
  const res = resolveIcon(withRole(ref, role), packs);
  if (res.kind !== 'none') return res;
  const fallback = getIconFallback();
  return fallback ? resolveIcon(fallback, packs) : res;
}

/** Resolve a reference and build its DOM — the one call a plain page needs. */
export function iconElement(
  ref: string | null | undefined,
  packs: IconPackSpec[],
  opts: IconElementOptions = {},
): HTMLElement {
  ensureIconStyles(opts.doc || document);
  return iconElementFor(resolveForRender(ref, packs, opts.role), opts);
}

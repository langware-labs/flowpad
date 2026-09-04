/**
 * The SDK's icon resolver and its no-framework renderer.
 *
 * These are the frontend half of the fence. The Python registry decides which
 * tags exist; this decides what each one renders as, and the two must agree —
 * a tag Python vouches for that the frontend draws as nothing is the same
 * silent hole the registry was built to close.
 */
import { describe, expect, it } from 'vitest';
import { iconChip, iconElement, iconTag, kebab, resolveIcon, type IconPackSpec } from '@sdk/icons';
import { isValidTag } from '@sdk/tags/grammar';

/** A miniature of the real shipped shape: carried packs, a declared family, and
 *  two packs that deliberately share a leaf. */
const PACKS: IconPackSpec[] = [
  {
    kind: 'brands',
    base: 'icons/brands/assets',
    icons: [
      { kind: 'slack', asset: 'slack.svg', tintable: false, aliases: ['Slack'] },
      { kind: 'claude', asset: 'claude.svg', sub: { restore: 'lucide.history' }, aliases: ['ClaudeCode', 'anthropic'] },
      { kind: 'notion', asset: 'notion.svg', tintable: false, dark: 'notion-dark.svg' },
      { kind: 'gitlab', asset: 'gitlab.svg', color: '#FC6D26' },
    ],
  },
  { kind: 'flowpad', base: 'icons/flowpad/assets', icons: [{ kind: 'wiki', asset: 'wiki.svg' }] },
  { kind: 'demo-a', base: 'icons/demo-a', icons: [{ kind: 'slack', asset: 'a.svg' }] },
  { kind: 'demo-b', base: 'icons/demo-b', icons: [{ kind: 'slack', asset: 'b.svg' }] },
  { kind: 'lucide', base: 'icons/lucide/assets', icons: [], served: ['rss', 'bar-chart-3', 'history', 'bell', 'file-text'] },
];

describe('tags', () => {
  it('names icons in the repo grammar, not an invented one', () => {
    expect(isValidTag('brands.slack')).toBe(true);
    expect(isValidTag('brands.claude.restore')).toBe(true);
    // The grammar this replaced. `:` and `@` are not in it, and `@` already
    // means something in `@local` parsing.
    expect(isValidTag('brands:slack')).toBe(false);
    expect(isValidTag('brands.claude@restore')).toBe(false);
  });

  it('kebabs before normalizing, or the word boundaries are lost', () => {
    expect(kebab('BarChart3')).toBe('bar-chart-3');
    expect(iconTag('BarChart3')).toBe('bar-chart-3');
  });
});

describe('resolveIcon', () => {
  it('resolves a full tag to exactly one icon', () => {
    const res = resolveIcon('brands.slack', PACKS);
    expect(res).toMatchObject({ kind: 'asset', tag: 'brands.slack', degraded: false, tintable: false });
  });

  it('reports the canonical tag whatever alias was used', () => {
    for (const alias of ['Slack', 'slack']) {
      expect(resolveIcon(alias, PACKS)).toMatchObject({ tag: 'brands.slack' });
    }
    for (const alias of ['ClaudeCode', 'anthropic']) {
      expect(resolveIcon(alias, PACKS)).toMatchObject({ tag: 'brands.claude' });
    }
  });

  it('treats a bare name as a lookup, not a downgrade', () => {
    expect(resolveIcon('Rss', PACKS)).toMatchObject({ tag: 'lucide.rss', degraded: false });
  });

  it('resolves a role as one more segment, with its sub-icon', () => {
    const res = resolveIcon('brands.claude.restore', PACKS);
    expect(res).toMatchObject({ tag: 'brands.claude.restore', degraded: false });
    expect(res.kind === 'asset' && res.url.endsWith('claude.svg')).toBe(true);
    expect(res.kind === 'asset' && res.badge?.kind).toBe('bundle');
  });

  it('degrades a missing role to the base, and says so', () => {
    const res = resolveIcon('brands.slack.restore', PACKS);
    expect(res).toMatchObject({ tag: 'brands.slack', asked: 'brands.slack.restore', degraded: true });
  });

  it('degrades a misspelled leaf too — which is why the fence tests exactness', () => {
    expect(resolveIcon('brands.slack.typo', PACKS)).toMatchObject({ tag: 'brands.slack', degraded: true });
  });

  it('hands back the dark variant alongside the default, never instead of it', () => {
    const res = resolveIcon('brands.notion', PACKS);
    expect(res.kind === 'asset' && res.url.endsWith('notion.svg')).toBe(true);
    expect(res.kind === 'asset' && res.darkUrl?.endsWith('notion-dark.svg')).toBe(true);
  });

  it('derives a bundle leaf and refuses one the pack does not serve', () => {
    expect(resolveIcon('BarChart3', PACKS)).toMatchObject({ kind: 'bundle', tag: 'lucide.bar-chart-3' });
    // Without the `served` check a typo resolves to a URL and 404s silently.
    expect(resolveIcon('Nonexsitent', PACKS).kind).toBe('none');
    expect(resolveIcon('brands.nope', PACKS).kind).toBe('none');
  });

  it('treats a path as a location, never a name lookup', () => {
    expect(resolveIcon('icons/my_type.svg', PACKS).kind).toBe('path');
  });

  it('answers none for empty input', () => {
    expect(resolveIcon('', PACKS).kind).toBe('none');
    expect(resolveIcon(null, PACKS).kind).toBe('none');
  });
});

describe('collisions', () => {
  it('gives two packs sharing a leaf two distinct icons', () => {
    expect(resolveIcon('demo-a.slack', PACKS).kind === 'asset' && resolveIcon('demo-a.slack', PACKS)).toMatchObject({
      tag: 'demo-a.slack',
    });
    const b = resolveIcon('demo-b.slack', PACKS);
    expect(b.kind === 'asset' && b.url.endsWith('b.svg')).toBe(true);
  });

  it('answers a bare shared leaf arbitrarily but stably', () => {
    const first = resolveIcon('slack', PACKS);
    expect(first.kind === 'asset' && ['brands.slack', 'demo-a.slack', 'demo-b.slack']).toContain(
      first.kind === 'asset' ? first.tag : '',
    );
    expect(resolveIcon('slack', PACKS)).toMatchObject({ tag: first.kind === 'asset' ? first.tag : '' });
  });
});

describe('iconElement', () => {
  it('masks a tintable glyph so it inherits currentColor', () => {
    const el = iconElement('flowpad.wiki', PACKS);
    expect(el.classList.contains('fp-icon-mask')).toBe(true);
    expect(el.getAttribute('style')).toContain('wiki.svg');
    expect(el.querySelector('img')).toBeNull();
  });

  it('draws a multi-colour mark as an image, which cannot be tinted', () => {
    const el = iconElement('brands.slack', PACKS);
    expect(el.classList.contains('fp-icon-mask')).toBe(false);
    expect(el.querySelector('img')?.getAttribute('src')).toContain('slack.svg');
  });

  it('ships both artworks when a dark variant exists, and lets CSS choose', () => {
    const el = iconElement('brands.notion', PACKS);
    expect(el.classList.contains('fp-icon-themed')).toBe(true);
    const srcs = [...el.querySelectorAll('img')].map((i) => i.getAttribute('src') || '');
    expect(srcs.some((s) => s.endsWith('notion.svg'))).toBe(true);
    expect(srcs.some((s) => s.endsWith('notion-dark.svg'))).toBe(true);
  });

  it('gives a sub-icon its own plate, so the mask is not painted over', () => {
    // A tintable glyph paints itself with `background-color: currentColor`. Put
    // the plate on the same element and it wins on specificity, painting the
    // badge in the plate's colour — invisible.
    const el = iconElement('brands.claude.restore', PACKS);
    expect(el.classList.contains('fp-icon-stack')).toBe(true);
    const plate = el.querySelector('.fp-icon-sub');
    expect(plate?.querySelector('.fp-icon-mask')).not.toBeNull();
    expect(plate?.classList.contains('fp-icon-mask')).toBe(false);
  });

  it('falls back to the generic glyph for an unknown tag', () => {
    // Matching `lucideByName`, which lands every unknown on FileText so that
    // "no icon" and "unknown icon" look alike instead of one vanishing.
    const el = iconElement('Nonexsitent', PACKS);
    expect(el.getAttribute('style')).toContain('file-text.svg');
  });

  it('sizes with ZERO specificity so a caller class always wins', () => {
    // The stylesheet is injected at runtime and therefore lands last in the
    // cascade. A plain `.fp-icon{width:1em}` would beat `h-4 w-4` at every one
    // of the app's ~1,600 call sites.
    iconElement('brands.slack', PACKS);
    const css = document.getElementById('flowpad-icon-css')?.textContent || '';
    expect(css).toContain(':where(.fp-icon)');
    expect(css).not.toMatch(/(^|\n)\.fp-icon\{[^}]*width/);
  });

  it('injects its stylesheet exactly once', () => {
    iconElement('brands.slack', PACKS);
    iconElement('flowpad.wiki', PACKS);
    expect(document.querySelectorAll('#flowpad-icon-css').length).toBe(1);
  });
});

describe('iconChip', () => {
  it('renders a glyph and its label', () => {
    const chip = iconChip('brands.slack', 'Slack', PACKS);
    expect(chip.classList.contains('fp-chip')).toBe(true);
    expect(chip.textContent).toBe('Slack');
    expect(chip.querySelector('img')?.getAttribute('src')).toContain('slack.svg');
  });

  it('has a compact treatment for category chips', () => {
    expect(iconChip('lucide.rss', 'RSS', PACKS, { compact: true }).classList.contains('fp-chip-compact')).toBe(true);
  });

  it('still shows its label when the glyph is unknown', () => {
    // The label is the part a person reads; a missing icon must not take it out.
    expect(iconChip('Nonexsitent', 'Something', PACKS).textContent).toBe('Something');
  });
});

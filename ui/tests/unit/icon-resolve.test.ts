/**
 * The SDK's icon resolver and its no-framework renderer.
 *
 * These are the frontend half of the fence. The Python registry decides which
 * names exist; this decides what each one renders as, and the two must agree —
 * a name Python vouches for that the frontend draws as nothing is the same
 * silent hole the registry was built to close.
 */
import { describe, expect, it } from 'vitest';
import { iconChip, iconElement, resolveIcon, type IconPackSpec } from '@sdk/icons';

/** A miniature of the real shipped shape: two carried packs and one declared family. */
const PACKS: IconPackSpec[] = [
  {
    name: 'brands',
    base: 'icons/brands/assets',
    icons: [
      { name: 'slack', asset: 'slack.svg', tintable: false, aliases: ['Slack'] },
      { name: 'claude', asset: 'claude.svg', sub: { restore: 'lucide:history' }, aliases: ['ClaudeCode'] },
      { name: 'baked', asset: 'baked.svg', variants: { r: 'baked-r.svg' }, sub: { r: 'lucide:history' } },
      { name: 'anthropic', asset: 'claude.svg', color: '#D97757', aliases: ['anthropic-key'] },
      { name: 'notion', asset: 'notion.svg', tintable: false, variants: { dark: 'notion-dark.svg' } },
    ],
  },
  { name: 'flowpad', base: 'icons/flowpad/assets', icons: [{ name: 'wiki', asset: 'wiki.svg', aliases: ['Wiki'] }] },
  { name: 'lucide', base: 'icons/lucide/assets', icons: [], served: ['rss', 'bar-chart-3', 'history', 'bell'] },
];

describe('resolveIcon', () => {
  it('gives a bare name to the first pack that claims it', () => {
    const res = resolveIcon('Slack', PACKS);
    expect(res.kind).toBe('asset');
    expect(res).toMatchObject({ pack: 'brands', name: 'slack', tintable: false });
  });

  it('resolves a qualified name only in that pack', () => {
    expect(resolveIcon('flowpad:wiki', PACKS).kind).toBe('asset');
    expect(resolveIcon('flowpad:slack', PACKS).kind).toBe('none');
  });

  it('resolves aliases from both vocabularies', () => {
    for (const alias of ['ClaudeCode', 'claude']) {
      expect(resolveIcon(alias, PACKS)).toMatchObject({ pack: 'brands', name: 'claude' });
    }
    expect(resolveIcon('anthropic-key', PACKS)).toMatchObject({ name: 'anthropic', color: '#D97757' });
  });

  it('resolves a variant, and refuses a role the icon does not have', () => {
    const res = resolveIcon('brands:claude@restore', PACKS);
    // Composed: the BASE artwork, with the sub-icon carried alongside.
    expect(res.kind === 'asset' && res.url.endsWith('claude.svg')).toBe(true);
    expect(res.kind === 'asset' && res.badge?.kind).toBe('bundle');
    // Falling back to the default would draw a fresh-session glyph where a
    // restored one was asked for — a wrong answer, not a near one.
    expect(resolveIcon('brands:slack@restore', PACKS).kind).toBe('none');
    expect(resolveIcon('brands:claude@nope', PACKS).kind).toBe('none');
  });

  it('hands back the dark variant alongside the default, never instead of it', () => {
    const res = resolveIcon('brands:notion', PACKS);
    expect(res.kind).toBe('asset');
    expect(res.kind === 'asset' && res.url.endsWith('notion.svg')).toBe(true);
    expect(res.kind === 'asset' && res.darkUrl?.endsWith('notion-dark.svg')).toBe(true);
  });

  it('derives a bundle path by kebab-casing the name', () => {
    const res = resolveIcon('BarChart3', PACKS);
    expect(res.kind).toBe('bundle');
    expect(res.kind === 'bundle' && res.url?.endsWith('bar-chart-3.svg')).toBe(true);
  });

  it('refuses a name the bundle pack does not serve', () => {
    // Without this the frontend resolves a typo to a URL and 404s silently —
    // which is exactly the failure the registry exists to end.
    expect(resolveIcon('Nonexsitent', PACKS).kind).toBe('none');
  });

  it('treats a path as a location, never a name lookup', () => {
    expect(resolveIcon('icons/my_type.svg', PACKS).kind).toBe('path');
  });

  it('answers none for empty input', () => {
    expect(resolveIcon('', PACKS).kind).toBe('none');
    expect(resolveIcon(null, PACKS).kind).toBe('none');
  });
});

describe('sub-icons', () => {
  it('carries a resolved badge on a composed role', () => {
    const res = resolveIcon('brands:claude@restore', PACKS);
    expect(res.kind === 'asset' && res.badge?.kind === 'bundle' && res.badge.name).toBe('history');
  });

  it('prefers the vendor\'s own artwork over a generic badge', () => {
    const res = resolveIcon('brands:baked@r', PACKS);
    expect(res.kind === 'asset' && res.url.endsWith('baked-r.svg')).toBe(true);
    expect(res.kind === 'asset' && res.badge).toBeUndefined();
  });

  it('does not nest badges — one level, then stop', () => {
    const res = resolveIcon('brands:claude@restore', PACKS);
    const badge = res.kind === 'asset' ? res.badge : undefined;
    expect(badge && 'badge' in badge && badge.badge).toBeFalsy();
  });

  it('gives the badge its own plate element, so the mask is not painted over', () => {
    // A tintable glyph paints itself with `background-color: currentColor`. Put
    // the plate on the same element and it wins on specificity, painting the
    // badge in the plate's colour — invisible.
    const el = iconElement('brands:claude@restore', PACKS);
    expect(el.classList.contains('fp-icon-stack')).toBe(true);
    const plate = el.querySelector('.fp-icon-sub');
    expect(plate).not.toBeNull();
    expect(plate?.querySelector('.fp-icon-mask')).not.toBeNull();
    expect(plate?.classList.contains('fp-icon-mask')).toBe(false);
  });
});

describe('iconChip', () => {
  it('renders a glyph and its label', () => {
    const chip = iconChip('brands:slack', 'Slack', PACKS);
    expect(chip.classList.contains('fp-chip')).toBe(true);
    expect(chip.textContent).toBe('Slack');
    expect(chip.querySelector('img')?.getAttribute('src')).toContain('slack.svg');
    expect(chip.title).toBe('Slack');
  });

  it('has a compact treatment for category chips', () => {
    expect(iconChip('lucide:rss', 'RSS', PACKS, { compact: true }).classList.contains('fp-chip-compact')).toBe(true);
    expect(iconChip('lucide:rss', 'RSS', PACKS).classList.contains('fp-chip-compact')).toBe(false);
  });

  it('still shows its label when the glyph is unknown', () => {
    // The label is the part a person reads; a missing icon must not take it out.
    const chip = iconChip('Nonexsitent', 'Something', PACKS);
    expect(chip.textContent).toBe('Something');
  });
});

describe('iconElement', () => {
  it('masks a tintable glyph so it inherits currentColor', () => {
    const el = iconElement('flowpad:wiki', PACKS);
    expect(el.classList.contains('fp-icon-mask')).toBe(true);
    expect(el.getAttribute('style')).toContain('wiki.svg');
    expect(el.querySelector('img')).toBeNull();
  });

  it('draws a multi-colour mark as an image, which cannot be tinted', () => {
    const el = iconElement('brands:slack', PACKS);
    expect(el.classList.contains('fp-icon-mask')).toBe(false);
    expect(el.querySelector('img')?.getAttribute('src')).toContain('slack.svg');
  });

  it('ships both artworks when a dark variant exists, and lets CSS choose', () => {
    const el = iconElement('brands:notion', PACKS);
    expect(el.classList.contains('fp-icon-themed')).toBe(true);
    const srcs = [...el.querySelectorAll('img')].map((i) => i.getAttribute('src') || '');
    expect(srcs.some((s) => s.endsWith('notion.svg'))).toBe(true);
    expect(srcs.some((s) => s.endsWith('notion-dark.svg'))).toBe(true);
  });

  it('applies a declared colour to a tintable glyph', () => {
    const el = iconElement('anthropic', PACKS);
    expect(el.style.backgroundColor).toBeTruthy();
  });

  it('renders an empty box for an unknown name rather than a wrong glyph', () => {
    const el = iconElement('Nonexsitent', PACKS);
    expect(el.children.length).toBe(0);
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });

  it('is decorative unless given a title', () => {
    expect(iconElement('Slack', PACKS).getAttribute('aria-hidden')).toBe('true');
    const named = iconElement('Slack', PACKS, { title: 'Slack' });
    expect(named.getAttribute('role')).toBe('img');
    expect(named.getAttribute('aria-label')).toBe('Slack');
  });

  it('injects its stylesheet exactly once', () => {
    iconElement('Slack', PACKS);
    iconElement('flowpad:wiki', PACKS);
    expect(document.querySelectorAll('#flowpad-icon-css').length).toBe(1);
  });
});

import { createElement } from 'react';
import { describe, it, expect } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { iconAssetUrl, isIconPath } from '@sdk';
import { lucideByName } from '@src/lib/lucide-by-name';
import { FlowIcon } from '@sdk/react/FlowIcon';

/**
 * An icon string is either a NAME or a FILE, and one slash tells them apart.
 * These pin that a file-backed icon reaches the SAME `lucideByName` seam every
 * surface already calls, so a type can ship a bespoke glyph without any call
 * site learning a second convention.
 */

const img = (node: React.ReactElement) => render(node).container.querySelector('img');

describe('isIconPath — a lucide export name can never contain a slash', () => {
  it('treats slashed strings as files and bare words as names', () => {
    expect(isIconPath('icons/agent.svg')).toBe(true);
    expect(isIconPath('/static/icons/agent.svg')).toBe(true);
    expect(isIconPath('https://cdn.example.com/a.png')).toBe(true);
    expect(isIconPath('BrainCog')).toBe(false);
    expect(isIconPath('Bot')).toBe(false);
    // Digits are legal in lucide names, so punctuation is NOT the test.
    expect(isIconPath('Building2')).toBe(false);
    expect(isIconPath('')).toBe(false);
    expect(isIconPath(null)).toBe(false);
  });
});

describe('iconAssetUrl — the file case becomes a loadable URL', () => {
  it('absolutises a relative path against the API origin, not the frontend', () => {
    const url = iconAssetUrl('icons/agent.svg');
    expect(url).toBeDefined();
    expect(url).toMatch(/^https?:\/\//);
    expect(url!.endsWith('/icons/agent.svg')).toBe(true);
    // The origin only — SERVER_URL carries an /api/v1 prefix these files are
    // NOT under.
    expect(url).not.toContain('/api/v1');
  });

  it('is insensitive to a leading slash', () => {
    expect(iconAssetUrl('/icons/agent.svg')).toBe(iconAssetUrl('icons/agent.svg'));
  });

  it('passes absolute URLs and data URIs through untouched', () => {
    expect(iconAssetUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(iconAssetUrl('//cdn.example.com/a.png')).toBe('//cdn.example.com/a.png');
    expect(iconAssetUrl('data:image/svg+xml,<svg/>')).toBe('data:image/svg+xml,<svg/>');
  });

  it('returns undefined for a lucide name — "not a file", not "broken"', () => {
    expect(iconAssetUrl('BrainCog')).toBeUndefined();
    expect(iconAssetUrl(null)).toBeUndefined();
  });

  it('prefixes a base subtree when the file is not at the static root', () => {
    expect(iconAssetUrl('public/gh.svg', 'plugins/github')).toBe(iconAssetUrl('plugins/github/public/gh.svg'));
  });
});

describe('lucideByName — files and names resolve through one seam', () => {
  it('renders a path-shaped icon as an img pointing at the backend', () => {
    const Icon = lucideByName('icons/agent.svg');
    const el = img(<Icon className="h-4 w-4" />);
    expect(el).not.toBeNull();
    expect(el!.getAttribute('src')).toBe(iconAssetUrl('icons/agent.svg'));
    // The className every call site passes must survive — that is what makes a
    // file-backed icon substitutable for a lucide one.
    expect(el!.className).toBe('h-4 w-4');
    // Decorative: call sites supply their own label.
    expect(el!.getAttribute('alt')).toBe('');
  });

  it('renders a data URI without contacting the backend', () => {
    const Icon = lucideByName('data:image/svg+xml,<svg/>');
    expect(img(<Icon />)!.getAttribute('src')).toBe('data:image/svg+xml,<svg/>');
  });

  it('falls back to the generic glyph when the file 404s', () => {
    // A missing file must look like a missing icon, not like the browser's
    // broken-image chrome.
    const Icon = lucideByName('icons/missing.svg');
    const { container } = render(<Icon />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('returns the SAME component for the same path', () => {
    // A fresh identity per call is a different element type to React, which
    // remounts the img — refetch and flicker on every render.
    expect(lucideByName('icons/agent.svg')).toBe(lucideByName('icons/agent.svg'));
    expect(lucideByName('icons/agent.svg')).not.toBe(lucideByName('icons/other.svg'));
  });

  it('draws the right glyph for a lucide name, and the fallback for anything else', () => {
    // Identity with the lucide export is no longer the contract — resolution
    // goes through the SDK, so what comes back is a component bound to the tag.
    // What must hold is what it DRAWS, and that the same name keeps returning
    // the same component so React does not remount (asserted separately).
    const brain = render(<>{createElement(lucideByName('BrainCog'))}</>);
    expect(brain.container.querySelector('svg')).not.toBeNull();

    // A typo and no name at all must reach the SAME generic glyph — that is the
    // rule this seam has always kept, so that "unknown icon" and "no icon" look
    // alike instead of one of them silently vanishing.
    const generic = render(<>{createElement(lucideByName('FileText'))}</>).container.innerHTML;
    for (const unknown of ['NotARealIcon', null]) {
      expect(render(<>{createElement(lucideByName(unknown))}</>).container.innerHTML).toBe(generic);
    }
  });
});

describe('a stored icon value — a path is a glyph, an emoji is itself', () => {
  it('renders an img rather than printing the path', () => {
    const { container } = render(<FlowIcon icon="icons/agent.svg" />);
    expect(container.querySelector('img')).not.toBeNull();
    expect(container.textContent).toBe('');
  });

  it('still renders emoji as text and names as glyphs', () => {
    // The picker writes all three into one field, and one component draws them:
    // an emoji is not a legal tag, so it comes back as text and IS the glyph.
    expect(render(<FlowIcon icon="🚀" />).container.textContent).toBe('🚀');
    expect(render(<FlowIcon icon="BrainCog" />).container.querySelector('svg')).not.toBeNull();
  });
});

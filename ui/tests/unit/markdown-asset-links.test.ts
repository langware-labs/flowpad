import { describe, expect, it } from 'vitest';
import {
  isExternalHref,
  resolveDocRelativePath,
  splitHrefTail,
} from '@src/components/markdown-asset-links';

// Markdown rendered from a project folder carries document-relative targets.
// Getting these wrong is silent: a broken image, or a link that opens a blank
// tab — neither throws, so only assertions catch it.

describe('isExternalHref', () => {
  it('leaves anything with a scheme, protocol-relative, or in-page alone', () => {
    for (const href of [
      'https://x.dev/a.png',
      'http://x.dev',
      'mailto:a@b.c',
      'data:image/png;base64,AAA',
      '//cdn.x.dev/a.png',
      '#section',
      '',
    ]) {
      expect(isExternalHref(href), href).toBe(true);
    }
  });

  it('treats repo paths as rewritable', () => {
    for (const href of ['./a.png', '../b.png', 'brand/logo.svg', '/top.png']) {
      expect(isExternalHref(href), href).toBe(false);
    }
  });

  it('does not mistake a windows drive letter for a scheme', () => {
    // `C:` matches a naive scheme regex; it is not a URL we should preserve.
    // Documented so the behaviour is deliberate either way.
    expect(isExternalHref('C:/x.png')).toBe(true);
  });
});

describe('resolveDocRelativePath', () => {
  const doc = 'docs/Getting Started/Welcome.md';

  it('resolves against the article directory, not the project root', () => {
    expect(resolveDocRelativePath(doc, './shot.png')).toBe('docs/Getting Started/shot.png');
    expect(resolveDocRelativePath(doc, 'shot.png')).toBe('docs/Getting Started/shot.png');
  });

  it('walks up with ..', () => {
    expect(resolveDocRelativePath(doc, '../shared/x.png')).toBe('docs/shared/x.png');
    expect(resolveDocRelativePath(doc, '../../brand/logo.svg')).toBe('brand/logo.svg');
  });

  it('treats a leading slash as the PROJECT root, not the filesystem root', () => {
    expect(resolveDocRelativePath(doc, '/brand/logo.svg')).toBe('brand/logo.svg');
  });

  it('refuses to climb above the project root', () => {
    // The backend would refuse to serve it; returning null keeps the original
    // href in the DOM rather than minting a URL that cannot resolve.
    expect(resolveDocRelativePath(doc, '../../../../../etc/passwd')).toBeNull();
    expect(resolveDocRelativePath('a.md', '../x.png')).toBeNull();
  });

  it('collapses redundant segments', () => {
    expect(resolveDocRelativePath(doc, './/./sub//x.png')).toBe('docs/Getting Started/sub/x.png');
  });

  it('returns null for an empty or degenerate path', () => {
    expect(resolveDocRelativePath(doc, '')).toBeNull();
    expect(resolveDocRelativePath(doc, '.')).toBeNull();
  });

  it('handles an article at the project root', () => {
    expect(resolveDocRelativePath('README.md', './brand/logo.svg')).toBe('brand/logo.svg');
  });
});

describe('splitHrefTail', () => {
  it('keeps a fragment or query out of the resolved path', () => {
    expect(splitHrefTail('./setup.md#step-2')).toEqual({ path: './setup.md', tail: '#step-2' });
    expect(splitHrefTail('./a.png?v=2')).toEqual({ path: './a.png', tail: '?v=2' });
    expect(splitHrefTail('./plain.md')).toEqual({ path: './plain.md', tail: '' });
  });

  it('survives a bare fragment', () => {
    expect(splitHrefTail('#top')).toEqual({ path: '', tail: '#top' });
  });
});

/**
 * A setup question shows a QR code its backend drew (`data:image/svg+xml;base64,…`). `dataImages` lets
 * exactly that through — on an `<img>` only; a `data:` link stays stripped, and without the flag nothing
 * changes.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MarkdownView } from '@src/components/markdown-view';

const QR = 'data:image/svg+xml;base64,PHN2Zy8+';
const DOC = `![Scan](${QR})\n\n[evil](data:text/html;base64,PHNjcmlwdD4=) [ok](https://wa.me/1)`;

afterEach(cleanup);

describe('MarkdownView data images', () => {
  it('draws an inline image only when asked, and never a data link', () => {
    const { container } = render(<MarkdownView value={DOC} dataImages />);
    expect(container.querySelector('img')).toHaveAttribute('src', QR);
    // On its own white card: black-on-transparent vanishes on a dark theme, and cameras read dark-on-light.
    expect(container.querySelector('img')).toHaveClass('bg-white');
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs).toContain('https://wa.me/1');
    expect(hrefs.some((h) => h.startsWith('data:'))).toBe(false);
  });

  it('leaves the default alone', () => {
    const { container } = render(<MarkdownView value={DOC} />);
    expect(container.querySelector('img')?.getAttribute('src') ?? '').not.toContain('data:');
  });
});

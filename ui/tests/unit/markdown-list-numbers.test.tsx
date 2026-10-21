import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownView } from '@src/components/markdown-view';

describe('MarkdownView ordered lists', () => {
  it('keeps the number the author typed on every item', () => {
    const { container } = render(<MarkdownView value={'3. first\n5. second\n7. third'} typedListNumbers />);
    const values = [...container.querySelectorAll('li')].map((li) => li.getAttribute('value'));
    expect(values).toEqual(['3', '5', '7']);
  });

  it('counts on from the first item everywhere else (documents)', () => {
    const { container } = render(<MarkdownView value={'3. first\n5. second'} />);
    expect([...container.querySelectorAll('li')].map((li) => li.getAttribute('value'))).toEqual([null, null]);
  });
});

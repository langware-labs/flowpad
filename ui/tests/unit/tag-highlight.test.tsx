// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { TagHighlightObserver } from '@src/tags/highlight.onTag';
import { tagAttrs } from '@src/tags/tag-attrs';

function mount(url: string, children?: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      {children}
      <TagHighlightObserver />
    </MemoryRouter>,
  );
}

describe('TagHighlightObserver — generic highlight from the tag tag alone', () => {
  afterEach(cleanup);

  it('lights the tagged element when ?highlight= matches', async () => {
    mount('/?highlight=TestTag', <div {...tagAttrs('TestTag', 'button')} data-testid="tgt" />);
    await waitFor(() => {
      const el = document.querySelector('[data-tag="TestTag"]')!;
      expect(el.getAttribute('data-highlighted')).toBe('true');
      expect(el.classList.contains('ring-2')).toBe(true);
    });
  });

  it('does nothing without a highlight param', () => {
    mount('/', <div {...tagAttrs('TestTag', 'button')} />);
    const el = document.querySelector('[data-tag="TestTag"]')!;
    expect(el.getAttribute('data-highlighted')).toBeNull();
  });

  it('non-matching tag stays unlit', () => {
    mount('/?highlight=OtherTag', <div {...tagAttrs('TestTag', 'button')} />);
    const el = document.querySelector('[data-tag="TestTag"]')!;
    expect(el.getAttribute('data-highlighted')).toBeNull();
  });

  it('a late-mounted tagged element still lights (MutationObserver path)', async () => {
    mount('/?highlight=LateTag');
    const late = document.createElement('div');
    late.setAttribute('data-tag', 'LateTag');
    document.body.appendChild(late);
    await waitFor(() => expect(late.getAttribute('data-highlighted')).toBe('true'));
    late.remove();
  });

  it('MULTIPLE elements carrying the same tag all light', async () => {
    mount('/?highlight=MultiTag');
    const a = document.createElement('div');
    a.setAttribute('data-tag', 'MultiTag');
    const b = document.createElement('div');
    b.setAttribute('data-tag', 'MultiTag');
    document.body.append(a, b);
    await waitFor(() => {
      expect(a.getAttribute('data-highlighted')).toBe('true');
      expect(b.getAttribute('data-highlighted')).toBe('true');
    });
    a.remove();
    b.remove();
  });

  it('a REPLACED tagged element re-lights (cold-load re-render path)', async () => {
    // The real-world failure: the footer button is found early, then the footer
    // re-renders when project context loads, swapping the DOM node — the
    // highlight must follow the replacement, not die with the first node.
    mount('/?highlight=SwapTag');
    const first = document.createElement('div');
    first.setAttribute('data-tag', 'SwapTag');
    document.body.appendChild(first);
    await waitFor(() => expect(first.getAttribute('data-highlighted')).toBe('true'));

    first.remove();
    const second = document.createElement('div');
    second.setAttribute('data-tag', 'SwapTag');
    document.body.appendChild(second);
    await waitFor(() => expect(second.getAttribute('data-highlighted')).toBe('true'));
    second.remove();
  });
});

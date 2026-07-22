// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { TopicHighlightObserver } from '@src/topics/highlight.onTopic';
import { topicTag } from '@src/topics/topic-tag';

function mount(url: string, children?: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      {children}
      <TopicHighlightObserver />
    </MemoryRouter>,
  );
}

describe('TopicHighlightObserver — generic highlight from the topic tag alone', () => {
  afterEach(cleanup);

  it('lights the tagged element when ?highlight= matches', async () => {
    mount('/?highlight=TestTopic', <div {...topicTag('TestTopic', 'button')} data-testid="tgt" />);
    await waitFor(() => {
      const el = document.querySelector('[data-topic="TestTopic"]')!;
      expect(el.getAttribute('data-highlighted')).toBe('true');
      expect(el.classList.contains('ring-2')).toBe(true);
    });
  });

  it('does nothing without a highlight param', () => {
    mount('/', <div {...topicTag('TestTopic', 'button')} />);
    const el = document.querySelector('[data-topic="TestTopic"]')!;
    expect(el.getAttribute('data-highlighted')).toBeNull();
  });

  it('non-matching topic stays unlit', () => {
    mount('/?highlight=OtherTopic', <div {...topicTag('TestTopic', 'button')} />);
    const el = document.querySelector('[data-topic="TestTopic"]')!;
    expect(el.getAttribute('data-highlighted')).toBeNull();
  });

  it('a late-mounted tagged element still lights (MutationObserver path)', async () => {
    mount('/?highlight=LateTopic');
    const late = document.createElement('div');
    late.setAttribute('data-topic', 'LateTopic');
    document.body.appendChild(late);
    await waitFor(() => expect(late.getAttribute('data-highlighted')).toBe('true'));
    late.remove();
  });

  it('a REPLACED tagged element re-lights (cold-load re-render path)', async () => {
    // The real-world failure: the footer button is found early, then the footer
    // re-renders when project context loads, swapping the DOM node — the
    // highlight must follow the replacement, not die with the first node.
    mount('/?highlight=SwapTopic');
    const first = document.createElement('div');
    first.setAttribute('data-topic', 'SwapTopic');
    document.body.appendChild(first);
    await waitFor(() => expect(first.getAttribute('data-highlighted')).toBe('true'));

    first.remove();
    const second = document.createElement('div');
    second.setAttribute('data-topic', 'SwapTopic');
    document.body.appendChild(second);
    await waitFor(() => expect(second.getAttribute('data-highlighted')).toBe('true'));
    second.remove();
  });
});

import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { ConversationMessage } from '@sdk/entities/conversation';
import { MessageBubble } from '@src/components/conversation/MessageBubble';

/**
 * Bug: pasting / typing multi-line text into a conversation renders as a single
 * line. The newline survives composer → send → storage → into the DOM; it is
 * the message-bubble body that drops it, because the content <div> renders with
 * the browser-default `white-space: normal`, which collapses every "\n" to a
 * space.
 *
 * Proven switch (live, on the running app): injecting "A\nB" into the bubble's
 * content div with `white-space: normal` rendered one line (20px); flipping the
 * element to `white-space: pre-wrap` rendered two lines (40px); reverting
 * collapsed it back. The switch is the missing `whitespace-pre-wrap` class on
 * the content div at MessageBubble.tsx:316.
 *
 * jsdom doesn't resolve Tailwind classes to computed CSS, so we assert the
 * switch directly: the element that holds the message body must carry
 * `whitespace-pre-wrap`. Fails today (only `text-sm text-foreground/...`),
 * passes once the class is added.
 */
describe('MessageBubble — multi-line body preserves newlines', () => {
  function makeMessage(content: string): ConversationMessage {
    return { role: 'sender', content, sender_id: 'user-1', timestamp: '2026-06-15T10:00:00.000Z' };
  }

  it('renders the message body in a whitespace-preserving container', () => {
    const content = 'first line\nsecond line\nthird line';
    const { container } = render(<MessageBubble message={makeMessage(content)} senderName="Alice" />);

    // The element that directly holds the message body text.
    const bodyEl = Array.from(container.querySelectorAll('div')).find(
      (d) => d.textContent === content,
    );
    expect(bodyEl, 'message body element should render the full multi-line content').toBeTruthy();

    // The proven on/off switch: without `whitespace-pre-wrap` the browser
    // collapses the newlines, so the multi-line paste shows as one line.
    expect(bodyEl!.className).toContain('whitespace-pre-wrap');
  });
});

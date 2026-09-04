/**
 * A failure toast is the one notification people need to paste somewhere — into
 * an issue, a chat, a bug report — and it is also the one that vanishes on a
 * timer. The footer warnings popover has offered a copy affordance for a while;
 * the toast, which is where the text is actually in front of you, did not.
 *
 * Both surfaces show the SAME alert, so they copy through one helper: a person
 * who copies from the toast and a person who copies from the popover must get
 * the same string.
 */
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({
  toast: { custom: vi.fn(), dismiss: vi.fn() },
  Toaster: () => null,
}));

const { renderToast } = await import('@src/notifications/NotificationOutlet');
const { notificationText } = await import('@src/notifications/types');
import type { NotificationData } from '@src/notifications/types';

const data = (over: Partial<NotificationData> = {}): NotificationData =>
  ({ id: 'n1', level: 'error', title: 'Could not allocate an inbox', message: 'Inbox limit exceeded', timestamp: 0, ...over }) as NotificationData;

describe('notification copy affordance', () => {
  // Queries are scoped to each render's own container: `screen` searches the
  // whole document, so a previous test's toast still mounted there would answer
  // for this one — and the success case would pass or fail on the wrong node.
  const copyIn = (ui: React.ReactElement) =>
    render(ui).container.querySelector('[data-testid="notification-copy"]');

  it('offers copy on a failure toast', () => {
    expect(copyIn(renderToast(data(), 't1'))).toBeTruthy();
  });

  it('does not clutter a success toast with it', () => {
    expect(copyIn(renderToast(data({ level: 'success', title: 'Saved', message: undefined }), 't2'))).toBeNull();
  });

  it('copies the title and the message, which is what the popover copies too', () => {
    expect(notificationText({ title: 'Could not allocate an inbox', message: 'Inbox limit exceeded' })).toBe(
      'Could not allocate an inbox\nInbox limit exceeded',
    );
    // A titled alert with nothing under it copies as just the title — no stray newline.
    expect(notificationText({ title: 'Disconnected', message: undefined })).toBe('Disconnected');
  });
});

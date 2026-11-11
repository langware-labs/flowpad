/**
 * Two incoming messages from the same sender, in two conversations, each get their own popup.
 * The message popup's id used to be derived from level + title (= the sender's name), so the
 * second conversation REPLACED the first one's toast instead of showing one of its own.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { Toaster } from 'sonner';
import { afterEach, expect, test } from 'vitest';
import { renderDesktopNotification } from '@src/notifications/renderDesktopNotification';

afterEach(cleanup);

const toastTexts = () => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent ?? '');

test('a second conversation from the same sender gets its own popup', async () => {
  render(<Toaster />);
  act(() => {
    renderDesktopNotification({
      notify_type: 'message',
      title: 'Eran Shlomo',
      body: 'First conversation',
      click_target: { view_type: 'conversation', pointer: 'c1/message/m1' },
    });
  });
  act(() => {
    renderDesktopNotification({
      notify_type: 'message',
      title: 'Eran Shlomo',
      body: 'Second conversation',
      click_target: { view_type: 'conversation', pointer: 'c2/message/m2' },
    });
  });
  await waitFor(() => expect(toastTexts().some((t) => t.includes('Second conversation'))).toBe(true));
  expect(toastTexts().some((t) => t.includes('First conversation'))).toBe(true);
});

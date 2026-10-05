/**
 * `askNotification`: a sticky toast that asks, and resolves with the answer. The "Don't ask
 * again" box rides the clicked button's command args; closing the toast — its ×, or
 * `notify.dismiss` — resolves with no answer, so a caller holding a request never hangs.
 */
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const custom = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({
  toast: { custom, dismiss: vi.fn() },
  Toaster: () => null,
}));

const { askNotification } = await import('@src/notifications/ask');
const { notify } = await import('@src/notifications/notify');

const QUESTION = {
  id: 'q1',
  title: 'Smart navigation requires sign-in',
  choices: [
    { value: 'login', label: 'Log in' },
    { value: 'continue', label: 'Continue' },
  ],
  remember: { label: "Don't ask again" },
};

/** The toast the last `notify` drew, mounted. */
function lastToast() {
  const draw = custom.mock.calls.at(-1)![0] as (id: string) => React.ReactElement;
  return render(draw('q1')).container;
}
const q = (root: HTMLElement, id: string) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement;

describe('askNotification', () => {
  beforeEach(() => custom.mockClear());

  it('shows the choices and an unticked box, sticky', async () => {
    void askNotification(QUESTION);
    expect(custom.mock.calls.at(-1)![1]).toMatchObject({ id: 'q1', duration: Infinity });
    const root = lastToast();
    expect(q(root, 'notification-action-0').textContent).toBe('Log in');
    expect(q(root, 'notification-action-1').textContent).toBe('Continue');
    expect(q(root, 'notification-remember').getAttribute('data-state')).toBe('unchecked');
    notify.dismiss('q1');
  });

  it('resolves with the clicked choice, box unticked', async () => {
    const answer = askNotification(QUESTION);
    fireEvent.click(q(lastToast(), 'notification-action-1'));
    await expect(answer).resolves.toEqual({ value: 'continue', remember: false });
  });

  it('carries the ticked box with the choice', async () => {
    const answer = askNotification(QUESTION);
    const root = lastToast();
    fireEvent.click(q(root, 'notification-remember'));
    fireEvent.click(q(root, 'notification-action-0'));
    await expect(answer).resolves.toEqual({ value: 'login', remember: true });
  });

  it('resolves with no answer when the × closes it', async () => {
    const answer = askNotification(QUESTION);
    fireEvent.click(lastToast().querySelector('[aria-label="Dismiss notification"]')!);
    await expect(answer).resolves.toEqual({ value: null, remember: false });
  });

  it('resolves with no answer on notify.dismiss, and a second ask under the same id closes the first', async () => {
    const first = askNotification(QUESTION);
    const second = askNotification(QUESTION);
    await expect(first).resolves.toEqual({ value: null, remember: false });
    notify.dismiss('q1');
    await expect(second).resolves.toEqual({ value: null, remember: false });
  });
});

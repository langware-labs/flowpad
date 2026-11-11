/**
 * The corner toast stack: "Clear all" appears above the top toast once more than two are up and
 * takes every toast down; a toast with actions also carries a "Dismiss" button beside them.
 */
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sonner = vi.hoisted(() => ({ custom: vi.fn(), dismiss: vi.fn() }));
vi.mock('sonner', () => ({ toast: sonner, Toaster: () => null }));

const { notify } = await import('@src/notifications/notify');
const { useToastStackStore } = await import('@src/notifications/toast-stack-store');

/** Mount toast `id` as `notify` last drew it. */
function draw(id: string) {
  const call = sonner.custom.mock.calls.findLast((c) => c[1].id === id)!;
  return render((call[0] as (id: string) => React.ReactElement)(id)).container;
}
const q = (root: HTMLElement, id: string) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('toast stack', () => {
  beforeEach(() => {
    sonner.custom.mockClear();
    sonner.dismiss.mockClear();
    useToastStackStore.setState({ ids: [] });
  });

  it('offers "Clear all" on the top toast only once more than two are up', () => {
    for (const id of ['a', 'b']) notify.info({ id, title: id });
    expect(q(draw('a'), 'notification-clear-all')).toBeNull();

    notify.info({ id: 'c', title: 'c' });
    expect(q(draw('c'), 'notification-clear-all')).toBeNull();
    fireEvent.click(q(draw('a'), 'notification-clear-all')!);
    expect(sonner.dismiss.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
  });

  it('forgets a toast that went away by itself', () => {
    for (const id of ['a', 'b', 'c']) notify.info({ id, title: id });
    sonner.custom.mock.calls[0][1].onAutoClose();
    expect(useToastStackStore.getState().ids).toEqual(['b', 'c']);
  });

  it('puts "Dismiss" beside a toast\'s actions', () => {
    notify.info({ id: 'a', title: 'a', actions: [{ label: 'Open', href: '/x' }] });
    fireEvent.click(q(draw('a'), 'notification-dismiss')!);
    expect(sonner.dismiss).toHaveBeenCalledWith('a');
  });
});

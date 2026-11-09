/** A message that could not reach the hub toasts "Not sent yet" with a Retry that resends its conversation. */
import { describe, expect, it, vi } from 'vitest';

let onOp: ((typeId: { id: string }, op: unknown, data: unknown) => void) | undefined;
vi.mock('@sdk/FlowSync/entity-ops', () => ({
  subscribeToEntityOps: (_t: string, cb: typeof onOp) => {
    onOp = cb;
    return () => {};
  },
}));
const notifySpy = vi.fn();
vi.mock('@src/notifications/notify', () => ({
  notify: Object.assign(notifySpy, { dismiss: vi.fn(), error: vi.fn() }),
  dismiss: vi.fn(),
}));
const resend = vi.fn(() => Promise.resolve());
vi.mock('@sdk', async (orig) => ({ ...(await orig<object>()), resendConversation: resend }));

const { initNotificationIngest } = await import('@src/notifications/ingest');
const { runAction } = await import('@src/notifications/commands');

describe('a message the hub could not take', () => {
  it('offers Retry, and Retry resends the conversation', () => {
    initNotificationIngest();
    onOp!({ id: 'm1' }, 'update', {
      outbound: true,
      delivery_status: 'created',
      conversation_id: 'c1',
      delivery_failure: { kind: 'offline', message: "Can't reach the hub right now." },
    });
    const shown = notifySpy.mock.calls.find((c) => c[0]?.id === 'delivery:m1')![0];
    const retry = shown.actions.find((a: { label: string }) => a.label === 'Retry');
    expect(retry).toBeTruthy();
    runAction(retry, shown.id);
    expect(resend).toHaveBeenCalledWith('c1');
  });
});

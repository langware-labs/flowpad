import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { credentialsService, dataContext } from '@sdk';
import { SealedValuesPanel } from '@src/components/conversation/SealedValuesPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MEMBERS = [
  { user_id: 'u-ami', name: 'Ami Levy' },
  { user_id: 'u-gadi', name: 'Gadi' },
  { user_id: 'u-dana', name: 'Dana' },
  { user_id: 'u-noa', name: 'Noa' },
];

describe('SealedValuesPanel — the sender sees Sent → Delivered → Validated per receiver', () => {
  it('one line per receiver, with the state their Flowpad reported', async () => {
    vi.spyOn(dataContext, 'caps', 'get').mockReturnValue({ localFiles: true } as never);
    vi.spyOn(credentialsService, 'sealedState').mockResolvedValue({
      incoming: [],
      sent: [
        {
          message_id: 'm-1',
          transfer_id: 'vault:abc',
          expires_at: null,
          route: 'vault',
          expired: false,
          recipients: { 'u-ami': 'filled', 'u-gadi': 'filled', 'u-dana': 'pending', 'u-noa': 'filled' },
          tests: {
            'u-ami': { state: 'ok', at: '2026-11-01T10:00:00+00:00' },
            'u-gadi': { state: 'invalid', at: '2026-11-01T10:00:00+00:00' },
          },
        },
      ],
    });
    render(<SealedValuesPanel conversationId="c-1" members={MEMBERS} />);
    const lines = await screen.findAllByTestId('sealed-receiver');
    const byName = Object.fromEntries(lines.map((l) => [l.textContent?.split('·')[0].trim(), l]));
    expect(screen.getByText('Shared values · secret manager')).toBeTruthy();
    expect(byName['Ami Levy'].textContent).toContain('Validated');
    expect(byName['Gadi'].textContent).toContain('Key refused by the provider');
    expect(byName['Dana'].dataset.stage).toBe('pending');
    expect(byName['Dana'].textContent).toContain('Not fetched yet');
    expect(byName['Noa'].textContent).toContain('Not reported'); // an older Flowpad: delivered, no test state
  });
});

describe('SealedValuesPanel — an open conversation shows the receiver\'s answer as it arrives', () => {
  it('re-reads on every update of its conversation, even one that leaves updated_date as it was', async () => {
    // A receiver's ack is a hub-only message: the backend's arrival hook pushes the conversation UNCHANGED
    // (notify_updated, no save), so `version` (updated_date) stays put. The store still re-emits the push as
    // `app.entity.updated` on `conversation:<id>`; the sender's card must re-read on it, not wait for a reload.
    vi.spyOn(dataContext, 'caps', 'get').mockReturnValue({ localFiles: true } as never);
    const row = (stage: 'pending' | 'filled') => ({
      message_id: 'm-1', transfer_id: 't-1', expires_at: null, route: 'sealed', expired: false,
      recipients: { 'u-bob': stage },
    });
    const state = vi.spyOn(credentialsService, 'sealedState')
      .mockResolvedValueOnce({ incoming: [], sent: [row('pending')] } as never)
      .mockResolvedValue({ incoming: [], sent: [row('filled')] } as never);
    render(<SealedValuesPanel conversationId="c-1" version="2026-11-11T14:52:43Z" members={[{ user_id: 'u-bob', name: 'Bob' }]} />);
    expect((await screen.findByTestId('sealed-receiver')).dataset.stage).toBe('pending');

    const { EventBus } = await import('@sdk/tags/EventBus');
    EventBus.emit('app.entity.updated', 'conversation:c-other', { entity: null }, { origin: 'app' });
    EventBus.emit('app.entity.updated', 'conversation:c-1', { entity: null }, { origin: 'app' });

    await waitFor(() => expect(screen.getByTestId('sealed-receiver').dataset.stage).toBe('filled'));
    expect(state).toHaveBeenCalledTimes(2); // the other conversation's update did not re-read this one
  });
});

describe('SealedValuesPanel — two answers in quick succession', () => {
  it('a push that lands while a read is in flight is read again after it, not folded into it', async () => {
    // Bob's Flowpad sends `filled`, then `validated` ~0.3 s later: the second push lands while the first read is
    // still in flight, and an identical GET in flight is joined, not re-sent. The card must still end on the later
    // state — read once more after the in-flight read, never left on the answer that predates the push.
    vi.spyOn(dataContext, 'caps', 'get').mockReturnValue({ localFiles: true } as never);
    const row = (tests?: Record<string, { state: string; at: string }>) => ({
      incoming: [], sent: [{ message_id: 'm-1', transfer_id: 't-1', expires_at: null, route: 'sealed', expired: false,
        recipients: { 'u-bob': 'filled' }, ...(tests ? { tests } : {}) }],
    });
    let release!: () => void;
    const state = vi.spyOn(credentialsService, 'sealedState')
      .mockResolvedValueOnce(row() as never) // the panel's first read
      .mockImplementationOnce(() => new Promise((r) => { release = () => r(row() as never); })) // in flight: before `validated`
      .mockResolvedValue(row({ 'u-bob': { state: 'ok', at: '2026-11-11T15:11:24Z' } }) as never);
    render(<SealedValuesPanel conversationId="c-1" members={[{ user_id: 'u-bob', name: 'Bob' }]} />);
    await screen.findByTestId('sealed-receiver');

    const { EventBus } = await import('@sdk/tags/EventBus');
    EventBus.emit('app.entity.updated', 'conversation:c-1', { entity: null }, { origin: 'app' }); // `filled` lands
    await waitFor(() => expect(state).toHaveBeenCalledTimes(2));
    EventBus.emit('app.entity.updated', 'conversation:c-1', { entity: null }, { origin: 'app' }); // `validated` lands
    release();

    await waitFor(() => expect(screen.getByTestId('sealed-receiver').dataset.test).toBe('ok'));
    expect(state).toHaveBeenCalledTimes(3);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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

/**
 * `NotificationsView` -- the mute link's key opens the hierarchy with the narrowest level picked;
 * Mute/Undo call the hub actions; a failed save keeps the pick; the rules list toggles a rule.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  list: vi.fn<() => Promise<unknown>>(),
  resolve: vi.fn<(key: string) => Promise<unknown>>(),
  mute: vi.fn<(key: string) => Promise<unknown>>(),
  unmute: vi.fn<(key: string) => Promise<unknown>>(),
}));

vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notificationRulesService: { list: h.list, resolve: h.resolve, mute: h.mute, unmute: h.unmute },
}));

import { NotificationsView, segmentOf } from '@src/components/notifications-view/NotificationsView';

const DEP = 'notification.email.issue.budget_exhausted.deployment.id.550e8400-e29b-41d4-a716-446655440000';
const LEVELS = [
  { key: 'notification.email', name: 'All Flowpad emails', muted: false },
  { key: 'notification.email.issue', name: 'Issue alerts', muted: false },
  { key: 'notification.email.issue.budget_exhausted', name: 'Out of tokens', muted: false },
  { key: DEP, name: 'This deployment', muted: false },
];

function renderView(pointer?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NotificationsView pointer={pointer} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.list.mockResolvedValue([]);
  h.resolve.mockResolvedValue({ rule: null, ancestors: LEVELS });
  h.mute.mockResolvedValue({ key: DEP, rule: { id: 'r1', rule_key: DEP, muted: true } });
  h.unmute.mockResolvedValue({ key: DEP, rule: null });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('NotificationsView', () => {
  it('shows each level by its own dot segment', () => {
    expect(LEVELS.map((_, i) => segmentOf(LEVELS, i))).toEqual([
      'notification.email',
      'issue',
      'budget_exhausted',
      'deployment.id.550e8400-e29b-41d4-a716-446655440000',
    ]);
  });

  it('pre-selects the narrowest level and mutes it, then Undo unmutes', async () => {
    renderView(DEP);
    await screen.findByTestId('mute-picker');
    expect(h.resolve).toHaveBeenCalledWith(DEP);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false', 'true']);

    await userEvent.click(screen.getByTestId('mute'));
    expect(h.mute).toHaveBeenCalledWith(DEP);
    expect((await screen.findByTestId('muted-line')).textContent).toContain(DEP);

    await userEvent.click(screen.getByTestId('undo'));
    expect(h.unmute).toHaveBeenCalledWith(DEP);
    await waitFor(() => expect(screen.getByTestId('mute')).toBeTruthy());
  });

  it('mutes a broader level when picked', async () => {
    renderView(DEP);
    await screen.findByTestId('mute-picker');
    await userEvent.click(screen.getAllByRole('radio')[1]);
    await userEvent.click(screen.getByTestId('mute'));
    expect(h.mute).toHaveBeenCalledWith('notification.email.issue');
  });

  it('a failed save says so and keeps the pick', async () => {
    h.mute.mockRejectedValueOnce(new Error('403'));
    renderView(DEP);
    await screen.findByTestId('mute-picker');
    await userEvent.click(screen.getByTestId('mute'));
    expect(await screen.findByTestId('mute-error')).toBeTruthy();
    expect(screen.getAllByRole('radio')[3].getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByTestId('muted-line')).toBeNull();
  });

  it('an unknown key shows an error, not a picker', async () => {
    h.resolve.mockRejectedValueOnce(new Error('400'));
    renderView('notification.email.nope');
    expect(await screen.findByTestId('mute-picker-error')).toBeTruthy();
  });

  it('without a key shows only the rules; a rule toggles through the hub', async () => {
    h.list.mockResolvedValue([{ id: 'r1', rule_key: DEP, muted: true }]);
    renderView();
    await screen.findByTestId('rules-list');
    expect(screen.queryByTestId('mute-picker')).toBeNull();
    await userEvent.click(screen.getByTestId(`rule-${DEP}`));
    expect(h.unmute).toHaveBeenCalledWith(DEP);
  });

  it('no rules says every email is on', async () => {
    renderView();
    expect(await screen.findByTestId('rules-empty')).toBeTruthy();
  });
});

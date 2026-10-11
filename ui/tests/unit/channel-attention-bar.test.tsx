/**
 * The strip a channel mark opens above the stream inbox list: per source that is not
 * listening, what is wrong, what to do, and the verb — with Verify's answer shown
 * in place rather than toasted.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from '@sdk';
import { fakeSource } from './fake-source';

const fake = (name: string, fields: Parameters<typeof fakeSource>[2] = {}) => fakeSource(name, 'gmail', fields);
const specFor = () => ({ sends: true, icon_name: 'Mail', setup_wiki: '' }) as never;

const openPage = vi.fn();
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openPage, openTab: vi.fn() } }),
}));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@src/components/setup-wizard/SetupStagesButton', () => ({ SetupStagesButton: () => null }));

import { ChannelAttentionBar } from '@src/components/stream-inbox-view/ChannelAttentionBar';
import { attentionAmong } from '@src/components/stream-inbox-view/channel-owner';
import { attentionReason } from '@src/components/data-sources/source-attention';

/** The strip over the given sources, each with its reason — what the stream inbox mounts. */
const bar = (sources: DataSource[]) => {
  const items = sources.map((source) => ({ source, reason: attentionReason(source)! }));
  return <ChannelAttentionBar items={items} specFor={specFor} />;
};

describe('attentionReason', () => {
  // Held keeps polling, but a file waits on a person; retrying is the scheduler's own backoff; and a
  // paused source carrying a stale transient error is paused, not retrying.
  it.each([
    ['unresolved', { status: 'new' }, { kind: 'unresolved', text: '' }],
    ['setup', { status: 'setup', setup_detail: 'Invite the bot.' }, { kind: 'setup', text: 'Invite the bot.' }],
    [
      'parked',
      { health: 'config_error', error_code: 'access_denied', error_detail: 'refused the login' },
      { kind: 'parked', text: 'access denied: refused the login' },
    ],
    ['paused', { status: 'disabled' }, { kind: 'paused', text: '' }],
    ['paused, stale error', { status: 'disabled', health: 'transient_error' }, { kind: 'paused', text: '' }],
    [
      'held',
      { health: 'ok', error_code: 'write_back_held', error_detail: 'notes.md' },
      { kind: 'held', text: 'notes.md' },
    ],
    ['retrying', { health: 'transient_error', error_detail: 'IMAP: timed out' }, { kind: 'retrying', text: 'IMAP: timed out' }],
    ['listening', {}, null],
  ])('%s: names the kind and speaks the source’s own words', (_name, fields, want) => {
    expect(attentionReason(fake('x', fields))).toEqual(want);
  });
});

describe('attentionAmong', () => {
  it('keeps only the picked channels that are not listening, each with why', () => {
    const rows = [fake('a', { status: 'setup' }), fake('b'), fakeSource('c', 'slack', { status: 'disabled' })];
    const picked = (...keys: string[]) => attentionAmong(rows, new Set(keys)).map((i) => [i.source.name, i.reason.kind]);
    expect(picked()).toEqual([]);
    expect(picked('gmail|gmail')).toEqual([['a', 'setup']]);
    expect(picked('gmail|gmail', 'slack|slack')).toEqual([
      ['a', 'setup'],
      ['c', 'paused'],
    ]);
  });
});

describe('ChannelAttentionBar', () => {
  afterEach(cleanup);

  it('a setup source shows its note, the next step, Verify and Settings', () => {
    const s = fake('s', { status: 'setup', setup_detail: 'Received — connect your own account, then press Verify.', account_key: 'me@x.test' });
    render(bar([s]));
    const row = screen.getByTestId(`channel-attention-${s.id}`);
    expect(row.dataset.kind).toBe('setup');
    expect(screen.getByTestId('channel-attention-wrong').textContent).toBe('Received — connect your own account, then press Verify.');
    expect(screen.getByTestId('channel-attention-next').textContent).toContain('press Verify');
    expect(row.textContent).toContain('me@x.test');
    fireEvent.click(screen.getByTestId('channel-attention-settings'));
    expect(openPage).toHaveBeenCalled();
    expect(JSON.stringify(openPage.mock.calls[0])).toContain('settings');
  });

  it('a source parked by a failed poll shows the error and offers Verify', () => {
    const p = fake('p', { health: 'config_error', error_code: 'access_denied', error_detail: 'Gmail refused the login' });
    render(bar([p]));
    expect(screen.getByTestId(`channel-attention-${p.id}`).dataset.kind).toBe('parked');
    expect(screen.getByTestId('channel-attention-wrong').textContent).toBe('access denied: Gmail refused the login');
    expect(screen.getByTestId('channel-attention-verify')).toBeTruthy();
    expect(screen.queryByTestId('channel-attention-resume')).toBeNull();
  });

  it('a paused source says so and offers Resume', () => {
    const d = fake('d', { status: 'disabled' });
    render(bar([d]));
    expect(screen.getByTestId(`channel-attention-${d.id}`).dataset.kind).toBe('paused');
    expect(screen.getByTestId('channel-attention-resume')).toBeTruthy();
    expect(screen.queryByTestId('channel-attention-verify')).toBeNull();
  });

  it('a held file and a retrying source are reported with Pull as the verb', () => {
    const h = fake('h', { health: 'ok', error_code: 'write_back_held', error_detail: 'notes.md' });
    const r = fake('r', { health: 'transient_error', error_detail: 'IMAP: timed out' });
    render(bar([h, r]));
    expect(screen.getByTestId(`channel-attention-${h.id}`).dataset.kind).toBe('held');
    expect(screen.getByTestId(`channel-attention-${r.id}`).dataset.kind).toBe('retrying');
    expect(screen.getAllByTestId('channel-attention-wrong').map((e) => e.textContent)).toEqual(['notes.md', 'IMAP: timed out']);
    expect(screen.getAllByTestId('channel-attention-pull')).toHaveLength(2);
    expect(screen.queryByTestId('channel-attention-verify')).toBeNull();
  });

  it('Verify’s answer replaces the two lines in place: ready, or the steps still owed', async () => {
    const s = fake('s', { status: 'setup', setup_detail: 'Invite the bot.' });
    const owed = { status: 'setup', ready: false, layer: 'setup', detail: 'Still waiting', pending: ['invite the bot', 'pair the phone'] } as const;
    const verify = vi.spyOn(s, 'verify').mockResolvedValueOnce({ ...owed, pending: [...owed.pending] });
    const wrong = () => screen.getByTestId('channel-attention-wrong').textContent;
    render(bar([s]));
    fireEvent.click(screen.getByTestId('channel-attention-verify'));
    await waitFor(() => expect(wrong()).toBe('Still waiting'));
    expect(screen.getByTestId('channel-attention-next').textContent).toContain('pair the phone');

    verify.mockResolvedValueOnce({ status: 'active', ready: true, layer: 'setup', detail: 'ready' });
    fireEvent.click(screen.getByTestId('channel-attention-verify'));
    await waitFor(() => expect(wrong()).toBe('Now listening.'));
  });

  it('a check that did not run says so, in place, without a toast', async () => {
    const s = fake('s', { status: 'setup' });
    vi.spyOn(s, 'verify').mockRejectedValueOnce(new Error('offline'));
    const { notify } = await import('@src/notifications');
    render(bar([s]));
    fireEvent.click(screen.getByTestId('channel-attention-verify'));
    await waitFor(() => expect(screen.getByTestId('channel-attention-wrong').textContent).toContain('offline'));
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('renders nothing for no sources', () => {
    render(bar([]));
    expect(screen.queryByTestId('channel-attention-bar')).toBeNull();
  });
});

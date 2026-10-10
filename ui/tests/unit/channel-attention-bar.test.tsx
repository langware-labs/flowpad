/**
 * The strip a channel mark opens above the inbox list: per source that is not
 * listening, what is wrong, what to do, and the verb — with Verify's answer shown
 * in place rather than toasted.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataSource } from '@sdk';

const LOCAL = 'user-11111111-1111-4111-8111-111111111111';
const uuidOf = (name: string) => `${name.charCodeAt(0).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const fake = (name: string, fields: Partial<Record<keyof DataSource, unknown>> = {}) =>
  new DataSource({ id: uuidOf(name), name, provider: 'gmail', channel: 'gmail', owner: LOCAL, status: 'active', ...fields } as never);
const specFor = () => ({ sends: true, icon_name: 'Mail', setup_wiki: '' }) as never;

const openPage = vi.fn();
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openPage, openTab: vi.fn() } }),
}));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@src/components/setup-wizard/SetupStagesButton', () => ({ SetupStagesButton: () => null }));

import { ChannelAttentionBar, attentionAmong } from '@src/components/stream-inbox-view/ChannelAttentionBar';
import { attentionReason } from '@src/components/data-sources/source-attention';

/** The strip over the given sources, each with its reason — what the inbox mounts. */
const bar = (sources: DataSource[]) => (
  <ChannelAttentionBar items={sources.map((source) => ({ source, reason: attentionReason(source)! }))} specFor={specFor} />
);

describe('attentionReason', () => {
  it('names the layer and speaks the source’s own words', () => {
    expect(attentionReason(fake('s', { status: 'setup', setup_detail: 'Invite the bot.' }))).toEqual({ kind: 'setup', text: 'Invite the bot.' });
    expect(attentionReason(fake('p', { health: 'config_error', error_code: 'access_denied', error_detail: 'refused the login' }))).toEqual({
      kind: 'parked',
      text: 'access denied: refused the login',
    });
    expect(attentionReason(fake('d', { status: 'disabled' }))).toEqual({ kind: 'paused', text: '' });
    expect(attentionReason(fake('ok'))).toBeNull();
    // Held is not attention: the source keeps polling.
    expect(attentionReason(fake('h', { health: 'ok', error_code: 'write_back_held', error_detail: 'x' }))).toBeNull();
  });

  it('attentionAmong keeps only the picked channels that are not listening', () => {
    const rows = [fake('a', { status: 'setup' }), fake('b'), fake('c', { status: 'disabled', provider: 'slack', channel: 'slack' })];
    const names = (selected: Set<string>) => attentionAmong(rows, selected).map((i) => [i.source.name, i.reason.kind]);
    expect(names(new Set())).toEqual([]);
    expect(names(new Set(['gmail|gmail']))).toEqual([['a', 'setup']]);
    expect(names(new Set(['gmail|gmail', 'slack|slack']))).toEqual([
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

  it('Verify’s answer replaces the two lines in place: ready, or the steps still owed', async () => {
    const s = fake('s', { status: 'setup', setup_detail: 'Invite the bot.' });
    const verify = vi.spyOn(s, 'verify').mockResolvedValueOnce({ status: 'setup', ready: false, layer: 'setup', detail: 'Still waiting', pending: ['invite the bot', 'pair the phone'] });
    render(bar([s]));
    await act(async () => {
      fireEvent.click(screen.getByTestId('channel-attention-verify'));
    });
    expect(screen.getByTestId('channel-attention-wrong').textContent).toBe('Still waiting');
    expect(screen.getByTestId('channel-attention-next').textContent).toContain('pair the phone');

    verify.mockResolvedValueOnce({ status: 'active', ready: true, layer: 'setup', detail: 'ready' });
    await act(async () => {
      fireEvent.click(screen.getByTestId('channel-attention-verify'));
    });
    expect(screen.getByTestId('channel-attention-wrong').textContent).toBe('Now listening.');
  });

  it('a check that did not run says so, in place, without a toast', async () => {
    const s = fake('s', { status: 'setup' });
    vi.spyOn(s, 'verify').mockRejectedValueOnce(new Error('offline'));
    const { notify } = await import('@src/notifications');
    render(bar([s]));
    await act(async () => {
      fireEvent.click(screen.getByTestId('channel-attention-verify'));
    });
    expect(screen.getByTestId('channel-attention-wrong').textContent).toContain('offline');
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('renders nothing for no sources', () => {
    render(bar([]));
    expect(screen.queryByTestId('channel-attention-bar')).toBeNull();
  });
});

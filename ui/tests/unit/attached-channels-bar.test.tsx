/**
 * The channels line: one round mark per channel kind with its state and count,
 * marks that FILTER (not toggle), and the two controls that give way to ×
 * while filtering.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DataSource, TypeId } from '@sdk';
import { LOCAL_OWNER as LOCAL, fakeSource } from './fake-source';

const fake = (name: string, status = 'active', provider = 'slack', fields: Parameters<typeof fakeSource>[2] = {}) =>
  fakeSource(name, provider, { status, ...fields });
const specFor = () => ({ sends: true, icon_name: 'Slack' }) as never;

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openTab: vi.fn() } }),
}));
vi.mock('@src/components/data-sources/DataSourceDialog', () => ({ DataSourceDialog: () => null }));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { AttachedChannelsBar, groupChannels } from '@src/components/stream-inbox-view/AttachedChannelsBar';

function mount(rows: DataSource[], selected = new Set<string>()) {
  const onSelectedChange = vi.fn();
  render(
    <AttachedChannelsBar
      owner={new TypeId(LOCAL)}
      rows={rows}
      specFor={specFor}
      selected={selected}
      onSelectedChange={onSelectedChange}
    />,
  );
  return onSelectedChange;
}

describe('AttachedChannelsBar', () => {
  afterEach(cleanup);

  it('shows one mark per channel kind with its state, and the two controls at rest', () => {
    mount([fake('a'), fake('b', 'disabled', 'gmail'), fake('c', 'setup', 'telegram')]);
    const marks = screen.getAllByTestId('attached-channel');
    expect(marks.map((e) => [e.getAttribute('aria-label'), e.dataset.state])).toEqual([
      ['b · paused', 'off'],
      ['a · listening', 'on'],
      ['c · needs attention', 'parked'],
    ]);
    expect(screen.getByTestId('attached-channels-add')).toBeTruthy();
    expect(screen.getByTestId('attached-channels-details')).toBeTruthy();
    expect(screen.queryByTestId('attached-channels-clear')).toBeNull();
  });

  it('a lit mark still wears "!" when one of its sources needs a person', () => {
    mount([fake('a', 'setup'), fake('b')]);
    const mark = screen.getByTestId('attached-channel');
    expect([mark.dataset.state, mark.dataset.attention, mark.getAttribute('aria-label')]).toEqual(['on', '1', 'slack × 2 · needs attention']);
    expect(screen.getByTestId('attached-channel-attention').textContent).toBe('!');
  });

  it('several sources of one kind share a mark with a count; clicking it filters to that kind', () => {
    const rows = [fake('a'), fake('b'), fake('c', 'disabled'), fake('g', 'active', 'gmail')];
    const save = vi.spyOn(rows[0], 'save');
    const onSelectedChange = mount(rows);
    const marks = screen.getAllByTestId('attached-channel');
    expect(marks.map((e) => [e.dataset.provider, e.dataset.count, e.dataset.state])).toEqual([
      ['gmail', '1', 'on'],
      ['slack', '3', 'on'],
    ]);
    expect(screen.getByTestId('attached-channel-count').textContent).toBe('3');
    fireEvent.click(marks[1]);
    expect(onSelectedChange).toHaveBeenCalledWith(new Set(['slack|slack']));
    expect(save).not.toHaveBeenCalled();
  });

  it('a group is parked only when nothing in it listens, and off only when everything is', () => {
    const state = (rows: DataSource[]) => groupChannels(rows)[0].state;
    expect(state([fake('a', 'setup'), fake('b')])).toBe('on');
    // …but a member that needs a person is still counted, so the "!" survives a listening sibling.
    expect(groupChannels([fake('a', 'setup'), fake('b')])[0].attention).toBe(1);
    expect(groupChannels([fake('a'), fake('b')])[0].attention).toBe(0);
    // A held file needs a person, so it draws "!"; a retrying source is the scheduler's own business.
    expect(state([fake('h', 'active', 'slack', { health: 'ok', error_code: 'write_back_held' })])).toBe('parked');
    expect(state([fake('r', 'active', 'slack', { health: 'transient_error' })])).toBe('on');
    expect(state([fake('a', 'setup'), fake('b', 'disabled')])).toBe('parked');
    expect(state([fake('a', 'disabled'), fake('b', 'disabled')])).toBe('off');
  });

  it('while filtering, the controls give way to ×, which shows everything again', () => {
    const onSelectedChange = mount([fake('a', 'active', 'gmail'), fake('b')], new Set(['gmail|gmail']));
    expect(screen.queryByTestId('attached-channels-add')).toBeNull();
    expect(screen.queryByTestId('attached-channels-details')).toBeNull();
    const marks = screen.getAllByTestId('attached-channel');
    expect(marks.map((e) => e.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    fireEvent.click(screen.getByTestId('attached-channels-clear'));
    expect(onSelectedChange).toHaveBeenCalledWith(new Set());
  });

  it('a channel row that is not listening says why — its setup note, or the error that parked it', () => {
    const parked = fake('p', 'active', 'gmail', {
      health: 'config_error',
      error_code: 'access_denied',
      error_detail: 'Gmail refused the login',
    });
    const owed = fake('s', 'setup', 'telegram', { setup_detail: 'Pair the phone.' });
    mount([parked, owed]);
    fireEvent.click(screen.getByTestId('attached-channels-details'));
    expect(screen.getAllByTestId('attached-channel-verify').map((e) => e.textContent)).toEqual([
      'access denied: Gmail refused the login',
      'Pair the phone.',
    ]);
  });

  it('pressing the reason runs the verb that recovers that kind: Verify, or Pull for a held file', () => {
    const owed = fake('s', 'setup', 'telegram', { setup_detail: 'Pair the phone.' });
    const held = fake('h', 'active', 'gmail', { health: 'ok', error_code: 'write_back_held', error_detail: 'a.md' });
    const verify = vi.spyOn(owed, 'verify').mockResolvedValue({ status: 'setup', ready: false, layer: 'setup', detail: '' });
    const pollNow = vi.spyOn(held, 'pollNow').mockResolvedValue({ status: 'active', health: 'ok', detail: 'queued' });
    const heldVerify = vi.spyOn(held, 'verify');
    mount([held, owed]);
    fireEvent.click(screen.getByTestId('attached-channels-details'));
    const [heldReason, owedReason] = screen.getAllByTestId('attached-channel-verify');
    expect([heldReason.title, owedReason.title]).toEqual(['Pull: a.md', 'Verify: Pair the phone.']);
    fireEvent.click(heldReason);
    fireEvent.click(owedReason);
    expect([pollNow.mock.calls.length, heldVerify.mock.calls.length, verify.mock.calls.length]).toEqual([1, 0, 1]);
  });

  it('a channel row names its account — the connected phone, the mailbox — when it has one', () => {
    const phone = fake('w', 'active', 'flow_whatsapp', { account_key: '972557709288' });
    mount([phone, fake('s')]);
    fireEvent.click(screen.getByTestId('attached-channels-details'));
    expect(screen.getAllByTestId('attached-channel-account').map((e) => e.textContent)).toEqual(['972557709288']);
  });
});

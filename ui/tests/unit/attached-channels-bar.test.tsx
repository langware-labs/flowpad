/**
 * The channels line: one round mark per channel kind with its state and count,
 * marks that FILTER (not toggle), and the two controls that give way to ×
 * while filtering.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataDriver, type DataSource, TypeId } from '@sdk';
import { LOCAL_OWNER as LOCAL, fakeSource } from './fake-source';

const fake = (name: string, status = 'active', provider = 'slack', fields: Parameters<typeof fakeSource>[2] = {}) =>
  fakeSource(name, provider, { status, ...fields });
const specFor = () => ({ sends: true, icon_name: 'Slack' }) as never;

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openTab: vi.fn() } }),
}));
vi.mock('@src/components/data-sources/DataSourceDialog', () => ({
  DataSourceDialog: ({ initial }: { initial?: { name?: string } }) => (
    <div data-testid="add-dialog" data-initial={initial?.name ?? ''} />
  ),
}));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { AttachedChannelsBar, groupChannels } from '@src/components/stream-inbox-view/AttachedChannelsBar';
import { channelOffers } from '@src/components/data-sources/use-source-specs';
import { needsPerson } from '@src/components/data-sources/source-attention';
import { useSourceSetupStore } from '@src/components/setup-wizard/source-setup-store';

// A person's own StreamInbox also carries the Diagnosis and Automations marks; these cases are about channel marks.
const channelMarks = () =>
  screen.getAllByTestId('attached-channel').filter((e) => !['diagnosis', 'automations', 'flowpad'].includes(e.dataset.provider ?? ''));

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
    const marks = channelMarks();
    expect(marks.map((e) => [e.getAttribute('aria-label'), e.dataset.state])).toEqual([
      ['b · paused', 'off'],
      ['a · listening', 'on'],
    ]);
    // "c" needs a person: it is counted in the chip, never drawn as a mark too.
    expect(screen.getByTestId('channel-warnings-chip').textContent).toBe('1');
    expect(screen.getByTestId('attached-channels-add')).toBeTruthy();
    expect(screen.getByTestId('attached-channels-details')).toBeTruthy();
    expect(screen.queryByTestId('attached-channels-clear')).toBeNull();
  });

  it('with onMarkPress a mark press goes to the caller and never touches the filter', () => {
    const onMarkPress = vi.fn();
    const onSelectedChange = vi.fn();
    render(
      <AttachedChannelsBar
        owner={new TypeId(LOCAL)}
        rows={[fake('a')]}
        specFor={specFor}
        selected={new Set()}
        onSelectedChange={onSelectedChange}
        onMarkPress={onMarkPress}
      />,
    );
    fireEvent.click(channelMarks()[0]);
    expect(onMarkPress).toHaveBeenCalledWith('slack|slack');
    expect(onSelectedChange).not.toHaveBeenCalled();
  });

  it('a source that needs a person leaves its mark for the chip, whose list holds exactly those', () => {
    mount([fake('a', 'setup'), fake('b'), fake('g', 'setup', 'gmail')]);
    // The slack kind keeps its mark for the listening source; gmail has none left to draw.
    expect(channelMarks().map((e) => [e.dataset.provider, e.dataset.count, e.dataset.state])).toEqual([
      ['slack', '1', 'on'],
    ]);
    const chip = screen.getByTestId('channel-warnings-chip');
    expect(chip.textContent).toBe('2');
    fireEvent.click(chip);
    expect(screen.getAllByTestId('attached-channel-row').map((e) => e.textContent)).toEqual([
      expect.stringContaining('a'),
      expect.stringContaining('g'),
    ]);
    expect(screen.getAllByTestId('attached-channel-verify')).toHaveLength(2);
  });

  it('no chip when nothing needs a person', () => {
    mount([fake('a'), fake('b', 'disabled', 'gmail')]);
    expect(screen.queryByTestId('channel-warnings-chip')).toBeNull();
  });

  it('several sources of one kind share a mark with a count; clicking it dims (filters out) that kind', () => {
    const rows = [fake('a'), fake('b'), fake('c', 'disabled'), fake('g', 'active', 'gmail')];
    const save = vi.spyOn(rows[0], 'save');
    const onSelectedChange = mount(rows);
    const marks = channelMarks();
    expect(marks.map((e) => [e.dataset.provider, e.dataset.count, e.dataset.state])).toEqual([
      ['gmail', '1', 'on'],
      ['slack', '3', 'on'],
    ]);
    expect(screen.getByTestId('attached-channel-count').textContent).toBe('3');
    // All marks are lit by default; a press dims that one and keeps the rest shown.
    expect(marks.map((e) => e.getAttribute('aria-pressed'))).toEqual(['true', 'true']);
    fireEvent.click(marks[1]);
    expect(onSelectedChange).toHaveBeenCalledWith(new Set(['flowpad', 'gmail|gmail', 'diagnosis', 'automations']));
    expect(save).not.toHaveBeenCalled();
  });

  it('who needs a person, and a mark is lit when anything in it listens', () => {
    // A held file needs a person; a retrying source is the scheduler's own business.
    expect(needsPerson(fake('h', 'active', 'slack', { health: 'ok', error_code: 'write_back_held' }))).toBe(true);
    expect(needsPerson(fake('r', 'active', 'slack', { health: 'transient_error' }))).toBe(false);
    // Nothing polls a source nobody has evaluated, so it must not draw as listening.
    expect(needsPerson(fake('n', 'new'))).toBe(true);
    expect(needsPerson(fake('p', 'disabled'))).toBe(false);
    const state = (rows: DataSource[]) => groupChannels(rows)[0].state;
    expect(state([fake('a'), fake('b', 'disabled')])).toBe('on');
    expect(state([fake('a', 'disabled'), fake('b', 'disabled')])).toBe('off');
  });

  it('while filtering, the + turns into × in its place — nothing else on the line moves — and × shows everything again', () => {
    const onSelectedChange = mount([fake('a', 'active', 'gmail'), fake('b')], new Set(['gmail|gmail']));
    expect(screen.queryByTestId('attached-channels-add')).toBeNull();
    // The rest of the line stays, so the marks a person points at do not shift.
    expect(screen.getByTestId('attached-channels-details')).toBeTruthy();
    const marks = channelMarks();
    expect(marks.map((e) => e.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    fireEvent.click(screen.getByTestId('attached-channels-clear'));
    expect(onSelectedChange).toHaveBeenCalledWith(new Set());
  });

  it('a channel row that is not listening says why — "Setup required", or the error that parked it', () => {
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
      'Setup required',
    ]);
  });

  it('pressing the reason runs what recovers that kind: Setup for a source in setup, Pull for a held file', () => {
    const owed = fake('s', 'setup', 'telegram', { setup_detail: 'Pair the phone.' });
    const held = fake('h', 'active', 'gmail', { health: 'ok', error_code: 'write_back_held', error_detail: 'a.md' });
    const verify = vi
      .spyOn(owed, 'verify')
      .mockResolvedValue({ status: 'setup', ready: false, layer: 'setup', detail: '' });
    const syncNow = vi
      .spyOn(held, 'syncNow')
      .mockResolvedValue({ ran: true, created: 0, updated: 0, unchanged: 1, health: 'ok', status: 'active' });
    const heldVerify = vi.spyOn(held, 'verify');
    mount([held, owed]);
    fireEvent.click(screen.getByTestId('attached-channels-details'));
    const [heldReason, owedReason] = screen.getAllByTestId('attached-channel-verify');
    expect([heldReason.title, owedReason.title]).toEqual(['Pull: a.md', 'Setup: Pair the phone.']);
    fireEvent.click(heldReason);
    fireEvent.click(owedReason);
    expect([syncNow.mock.calls.length, heldVerify.mock.calls.length, verify.mock.calls.length]).toEqual([1, 0, 0]);
    expect(useSourceSetupStore.getState()).toMatchObject({ open: true, payload: { source: owed } });
  });

  it('a channel row names its account — the connected phone, the mailbox — when it has one', () => {
    const phone = fake('w', 'active', 'flow_whatsapp', { account_key: '972500000000' });
    mount([phone, fake('s')]);
    fireEvent.click(screen.getByTestId('attached-channels-details'));
    expect(screen.getAllByTestId('attached-channel-account').map((e) => e.textContent)).toEqual(['972500000000']);
  });
});

/** Channels still to connect: drawn by default from the drivers that declare `featured`. */
describe('channel offers', () => {
  afterEach(cleanup);

  const driver = (name: string, fields: Partial<DataDriver> = {}) =>
    new DataDriver({ name, title: name, icon_name: 'Mail', sends: true, ...fields } as never);
  const specs = [
    driver('flow_chat', { group: 'Chat', group_order: 0, group_icon_name: 'Slack', featured: true }),
    driver('own_chat', { group: 'Chat', group_order: 1 }),
    driver('mailbox', { title: 'Mailbox', featured: true }),
    driver('feed', { featured: true, sends: false }),
    driver('plain'),
    driver('agent_mail', { featured: true, provisioned: true }),
  ];

  it('offers each featured message channel once — a group as one choice, opened on its first member', () => {
    expect(channelOffers(specs, [], false).map((o) => [o.key, o.label, o.iconName, o.spec.name])).toEqual([
      ['Chat', 'Chat', 'Slack', 'flow_chat'],
      ['mailbox', 'Mailbox', 'Mail', 'mailbox'],
    ]);
  });

  it('offers a provisioned channel to an agent only', () => {
    expect(channelOffers(specs, [], true).map((o) => o.key)).toContain('agent_mail');
  });

  it('folds once the owner has a source of any featured channel, whatever its status', () => {
    expect(channelOffers(specs, [fake('a', 'disabled', 'own_chat')], false)).toEqual([]);
    // A channel that is not featured (the tasks channel) does not count as connected.
    expect(channelOffers(specs, [fake('a', 'active', 'plain')], false)).toHaveLength(2);
  });

  it('a provisioned channel the hub does not offer is drawn disabled and says why — never a failed click', () => {
    const offers = channelOffers(specs, [], true).filter((o) => o.spec.provisioned);
    render(
      <AttachedChannelsBar
        owner={new TypeId(LOCAL)}
        rows={[]}
        specFor={specFor}
        offers={offers}
        builtInOffered={false}
        onSelectedChange={vi.fn()}
      />,
    );
    const mark = screen.getByTestId('channel-offer');
    expect(mark.dataset.unavailable).toBe('true');
    expect(mark.getAttribute('aria-label')).toMatch(/is off on this hub/);
    fireEvent.click(mark);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  const mountOffers = (selected = new Set<string>()) =>
    render(
      <AttachedChannelsBar
        owner={new TypeId(LOCAL)}
        rows={[fake('a', 'active', 'plain')]}
        specFor={specFor}
        offers={channelOffers(specs, [], false)}
        selected={selected}
        onSelectedChange={vi.fn()}
      />,
    );

  it('draws an offer beside the attached marks, and pressing it opens the add dialog on that channel', () => {
    mountOffers();
    expect(channelMarks()).toHaveLength(1);
    const offers = screen.getAllByTestId('channel-offer');
    expect(offers.map((e) => [e.dataset.channel, e.getAttribute('aria-label')])).toEqual([
      ['Chat', 'Connect Chat'],
      ['mailbox', 'Connect Mailbox'],
    ]);
    expect(screen.queryByTestId('add-dialog')).toBeNull();
    fireEvent.click(offers[0]);
    expect(screen.getByTestId('add-dialog').dataset.initial).toBe('flow_chat');
  });

  it('keeps the offers while the list is filtered — the line keeps its width', () => {
    mountOffers(new Set(['plain|plain']));
    expect(screen.queryAllByTestId('channel-offer').length).toBeGreaterThan(0);
  });
});

/**
 * The channels line: one round mark per channel kind with its state and count,
 * marks that FILTER (not toggle), and the two controls that give way to ×
 * while filtering.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataSource, TypeId } from '@sdk';

const LOCAL = 'user-11111111-1111-4111-8111-111111111111';
/** A real entity, so the status getters are the SDK's own. */
const uuidOf = (name: string) => `${name.charCodeAt(0).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const fake = (name: string, status = 'active', provider = 'slack') =>
  new DataSource({ id: uuidOf(name), name, provider, channel: provider, owner: LOCAL, status: status as DataSource['status'] });
const specFor = () => ({ sends: true, icon_name: 'Slack' }) as never;

vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: { openTab: vi.fn() } }) }));
vi.mock('@src/components/data-sources/DataSourceDialog', () => ({ DataSourceDialog: () => null }));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));

import { AttachedChannelsBar, groupChannels } from '@src/components/inbox-view/AttachedChannelsBar';

function mount(rows: DataSource[], selected = new Set<string>()) {
  const onSelectedChange = vi.fn();
  render(
    <AttachedChannelsBar owner={new TypeId(LOCAL)} rows={rows} specFor={specFor} selected={selected} onSelectedChange={onSelectedChange} />,
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
});

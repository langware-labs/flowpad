/**
 * The channels line: a round mark per channel with its status, marks that
 * FILTER (not toggle), and the two controls that give way to × while filtering.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypeId } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';

const LOCAL = 'user-11111111-1111-4111-8111-111111111111';
function fake(name: string, status = 'active', provider = 'slack') {
  return {
    id: name,
    name,
    provider,
    channel: 'slack',
    owner: LOCAL,
    config: {},
    status,
    health: 'ok',
    setup_detail: '',
    get isActive() {
      return this.status === 'active';
    },
    get needsSetup() {
      return this.status === 'setup';
    },
    get needsAttention() {
      return this.status === 'setup';
    },
    save: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    markEdit: vi.fn(),
  };
}
let sources: ReturnType<typeof fake>[] = [];

vi.mock('@src/hooks/entity-hooks', () => ({ useEntitiesQuery: () => ({ data: sources }) }));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ localUser: { id: LOCAL.slice('user-'.length) } }) }));
vi.mock('@src/components/data-sources/use-source-specs', () => ({
  sourcesQuery: {},
  isMessageSourceSpec: () => true,
  useSourceSpecs: () => ({ specs: [], specFor: () => ({ sends: true, icon_name: 'Slack' }) }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: { openTab: vi.fn() } }) }));
vi.mock('@src/components/data-sources/DataSourceDialog', () => ({ DataSourceDialog: () => null }));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));

import { AttachedChannelsBar, groupByProvider } from '@src/components/inbox-view/AttachedChannelsBar';

function mount(selected = new Set<string>()) {
  const onSelectedChange = vi.fn();
  render(
    <TooltipProvider>
      <AttachedChannelsBar owner={new TypeId(LOCAL)} selected={selected} onSelectedChange={onSelectedChange} />
    </TooltipProvider>,
  );
  return onSelectedChange;
}

describe('AttachedChannelsBar', () => {
  afterEach(cleanup);

  it('shows one mark per provider with its state, and the two controls at rest', () => {
    sources = [fake('a'), fake('b', 'disabled', 'gmail'), fake('c', 'setup', 'telegram')];
    mount();
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

  it('several sources of one provider share a mark with a count; clicking it filters to all of them', () => {
    sources = [fake('a'), fake('b'), fake('c', 'disabled'), fake('g', 'active', 'gmail')];
    const onSelectedChange = mount();
    const marks = screen.getAllByTestId('attached-channel');
    expect(marks.map((e) => [e.dataset.provider, e.dataset.count, e.dataset.state])).toEqual([
      ['gmail', '1', 'on'],
      ['slack', '3', 'on'],
    ]);
    expect(screen.getByTestId('attached-channel-count').textContent).toBe('3');
    fireEvent.click(marks[1]);
    expect(onSelectedChange).toHaveBeenCalledWith(new Set(['a', 'b', 'c']));
    expect(sources[0].save).not.toHaveBeenCalled();
  });

  it('a group is parked only when nothing in it listens, and off only when everything is', () => {
    const state = (list: ReturnType<typeof fake>[]) => groupByProvider(list as never)[0].state;
    expect(state([fake('a', 'setup'), fake('b')])).toBe('on');
    expect(state([fake('a', 'setup'), fake('b', 'disabled')])).toBe('parked');
    expect(state([fake('a', 'disabled'), fake('b', 'disabled')])).toBe('off');
  });

  it('while filtering, the controls give way to ×, which shows everything again', () => {
    sources = [fake('a', 'active', 'gmail'), fake('b')];
    const onSelectedChange = mount(new Set(['a']));
    expect(screen.queryByTestId('attached-channels-add')).toBeNull();
    expect(screen.queryByTestId('attached-channels-details')).toBeNull();
    const marks = screen.getAllByTestId('attached-channel');
    expect(marks.map((e) => e.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    fireEvent.click(screen.getByTestId('attached-channels-clear'));
    expect(onSelectedChange).toHaveBeenCalledWith(new Set());
  });
});

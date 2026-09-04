/**
 * The channels line: a round mark per channel with its status, marks that
 * FILTER (not toggle), and the two controls that give way to × while filtering.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypeId } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';

const LOCAL = 'user-11111111-1111-4111-8111-111111111111';
function fake(name: string, status = 'active') {
  return {
    id: name,
    name,
    provider: 'slack',
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

import { AttachedChannelsBar } from '@src/components/inbox-view/AttachedChannelsBar';

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

  it('shows every channel with its state, and the two controls at rest', () => {
    sources = [fake('a'), fake('b', 'disabled'), fake('c', 'setup')];
    mount();
    const marks = screen.getAllByTestId('attached-channel');
    expect(marks.map((e) => [e.getAttribute('aria-label'), e.dataset.state])).toEqual([
      ['a · listening', 'on'],
      ['b · paused', 'off'],
      ['c · needs attention', 'parked'],
    ]);
    expect(screen.getByTestId('attached-channels-add')).toBeTruthy();
    expect(screen.getByTestId('attached-channels-details')).toBeTruthy();
    expect(screen.queryByTestId('attached-channels-clear')).toBeNull();
  });

  it('a mark filters rather than toggles: nothing is saved, the selection changes', () => {
    sources = [fake('a'), fake('b')];
    const onSelectedChange = mount();
    fireEvent.click(screen.getAllByTestId('attached-channel')[1]);
    expect(onSelectedChange).toHaveBeenCalledWith(new Set(['b']));
    expect(sources[1].save).not.toHaveBeenCalled();
  });

  it('while filtering, the controls give way to ×, which shows everything again', () => {
    sources = [fake('a'), fake('b')];
    const onSelectedChange = mount(new Set(['a']));
    expect(screen.queryByTestId('attached-channels-add')).toBeNull();
    expect(screen.queryByTestId('attached-channels-details')).toBeNull();
    const marks = screen.getAllByTestId('attached-channel');
    expect(marks.map((e) => e.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    fireEvent.click(screen.getByTestId('attached-channels-clear'));
    expect(onSelectedChange).toHaveBeenCalledWith(new Set());
  });
});

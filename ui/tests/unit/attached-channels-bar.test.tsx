/**
 * The channels line: a chip per channel that is ON, its × turns it off, a
 * parked one wears a warning, and channels that are off are not chips.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypeId } from '@sdk';

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
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));

import { AttachedChannelsBar } from '@src/components/inbox-view/AttachedChannelsBar';

describe('AttachedChannelsBar', () => {
  afterEach(cleanup);

  it('shows a chip per channel that is on, none for one that is off, and a warning on a parked one', () => {
    sources = [fake('a'), fake('b', 'disabled'), fake('c', 'setup')];
    render(<AttachedChannelsBar owner={new TypeId(LOCAL)} />);
    const chips = screen.getAllByTestId('attached-channel');
    expect(chips.map((e) => [e.dataset.provider, e.textContent, e.dataset.state])).toEqual([
      ['slack', 'a', 'on'],
      ['slack', 'c', 'parked'],
    ]);
    expect(screen.getAllByTestId('attached-channel-fix')).toHaveLength(1);
    expect(screen.getByTestId('attached-channels-add')).toBeTruthy();
  });

  it('× is the off switch: it pauses the source', async () => {
    sources = [fake('a')];
    render(<AttachedChannelsBar owner={new TypeId(LOCAL)} />);
    fireEvent.click(screen.getByTestId('attached-channel-remove'));
    await vi.waitFor(() => expect(sources[0].save).toHaveBeenCalledTimes(1));
    expect(sources[0].status).toBe('disabled');
  });
});

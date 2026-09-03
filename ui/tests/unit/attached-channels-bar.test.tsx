/**
 * The channels bar: the fold arithmetic (pure), and the three icon states.
 */
import { cleanup, render, screen } from '@testing-library/react';
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
    get isActive() {
      return this.status === 'active';
    },
    get needsSetup() {
      return this.status === 'setup';
    },
    get needsAttention() {
      return this.status === 'setup';
    },
    save: vi.fn(),
    markEdit: vi.fn(),
  };
}
let sources: ReturnType<typeof fake>[] = [];

vi.mock('@src/hooks/entity-hooks', () => ({ useEntitiesQuery: () => ({ data: sources }) }));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ userTypeId: { toString: () => LOCAL } }) }));
vi.mock('@src/components/data-sources/use-source-specs', () => ({
  sourcesQuery: {},
  isMessageSourceSpec: () => true,
  useSourceSpecs: () => ({ specs: [], specFor: () => ({ sends: true, icon_name: 'Slack' }) }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: { openTab: vi.fn() } }) }));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));

import { AttachedChannelsBar, visibleCount } from '@src/components/inbox-view/AttachedChannelsBar';

describe('visibleCount', () => {
  it('shows everything when unmeasured or roomy, and folds only when it saves a slot', () => {
    expect(visibleCount(0, 4)).toBe(4); // jsdom / display:none: never fold on a bogus 0
    expect(visibleCount(6 * 32, 4)).toBe(4); // 4 icons + "+" fit
    expect(visibleCount(5 * 32, 4)).toBe(4); // exactly fits
    expect(visibleCount(4 * 32, 4)).toBe(2); // "+" and "…" take two, two icons stay
    expect(visibleCount(2 * 32, 4)).toBe(0); // only "+" and "…"
  });
});

describe('AttachedChannelsBar', () => {
  afterEach(cleanup);

  it('lights a listening channel, dims a paused one, badges a parked one', () => {
    sources = [fake('a'), fake('b', 'disabled'), fake('c', 'setup')];
    render(
      <TooltipProvider>
        <AttachedChannelsBar owner={new TypeId(LOCAL)} />
      </TooltipProvider>,
    );
    const icons = screen.getAllByTestId('attached-channel');
    expect(icons.map((e) => e.dataset.state)).toEqual(['listening', 'paused', 'parked']);
    expect(icons.map((e) => e.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(icons[2].getAttribute('aria-label')).toContain('needs attention');
    expect(screen.queryByTestId('attached-channels-more')).toBeNull();
    expect(screen.getByTestId('attached-channels-add')).toBeTruthy();
  });
});

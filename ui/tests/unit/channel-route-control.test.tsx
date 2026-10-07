/**
 * "Delivered to": the hub webhook claim behind a channel, read from the hub each time it is shown. A
 * developer's channel switches between this computer and a cloud placement of its agent (the URL stays);
 * Flow's own channel is answered from Flow's box and has no switch; a channel with no claim shows nothing.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataSource, type ChannelRoute } from '@sdk';

vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));

import { ChannelRouteControl } from '@src/components/data-sources/ChannelRouteControl';

afterEach(cleanup);

const CLAIM = {
  id: 'c-1',
  url: 'https://hub.example/api/v1/webhook/c-1',
  provider: 'whatsapp',
  status: 'active' as const,
  claim: { kind: 'account' as const, key: '555000' },
  target: { kind: 'desktop' as const, instance_id: 'inst-1', data_source_id: 'ds-1' },
  watch: { kind: 'none' as const },
  deliveries: 3,
  misroutes: 1,
  recent: [{ at: 1_791_300_000, method: 'POST', status: 200 }],
};

function sourceWith(route: ChannelRoute) {
  const source = new DataSource({ id: '0b1e8c3a-1d6f-4a52-9a77-5d1b2f3e4c5d', name: 'Bot', provider: 'whatsapp' });
  source.route = vi.fn(async () => route);
  source.setRoute = vi.fn(async (place: string) => ({ claim: CLAIM, current: place }));
  return source;
}

describe('ChannelRouteControl', () => {
  it('shows the webhook URL, the deliveries and a misroute, and where it delivers now', async () => {
    const places = [
      { key: 'this', label: 'This computer' },
      { key: 'dep-1', label: 'production · e2b', node_typeid: 'compute_node-1' },
    ];
    render(<ChannelRouteControl source={sourceWith({ claim: CLAIM, places, current: 'this' })} />);

    expect((await screen.findByTestId('channel-route-url')).textContent).toBe(CLAIM.url);
    expect(screen.getByTestId('channel-route-stats').textContent).toContain('1 misrouted');
    expect(screen.getByTestId('channel-route-place').textContent).toContain('This computer');
  });

  it("says Flow's channel is answered from Flow's box, with no switch", async () => {
    const flow = { ...CLAIM, target: { kind: 'placement' as const, agent_typeid: 'agent-f' } };
    render(<ChannelRouteControl source={sourceWith({ claim: flow, places: [], current: 'flow' })} />);

    expect(await screen.findByTestId('channel-route-flow')).toBeTruthy();
    expect(screen.queryByTestId('channel-route-place')).toBeNull();
  });

  it('shows nothing for a channel no hub claim delivers to', async () => {
    const source = sourceWith({ claim: null, places: [], current: '' });
    const { container } = render(<ChannelRouteControl source={source} />);

    await waitFor(() => expect(source.route).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });
});

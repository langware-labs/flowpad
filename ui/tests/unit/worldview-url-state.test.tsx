import { act, renderHook } from '@testing-library/react';
import { TypeId, ViewType } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { useGraphUrlState } from '@src/components/graph-view/url-state';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openDock = vi.hoisted(() => vi.fn());
const navigationState = vi.hoisted(() => ({ currentDock: null as DockPointer | null }));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    currentDock: navigationState.currentDock,
    navigation: { openDock },
  }),
}));

const ROOT_ID = 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa';
const CHILD_ID = 'bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb';

describe('WorldView URL-first selection', () => {
  beforeEach(() => {
    openDock.mockClear();
    navigationState.currentDock = DockPointer.forWorldView(new TypeId('deployment', ROOT_ID));
  });

  it('turns node selection into a WorldView navigation without changing the root', () => {
    const { result } = renderHook(() => useGraphUrlState('worldview'));

    expect(result.current.state.color).toBe('type');
    act(() => result.current.setState({ selected: `deployment-${CHILD_ID}` }));

    expect(openDock).toHaveBeenCalledTimes(1);
    const next = openDock.mock.calls[0][0] as DockPointer;
    expect(next.viewType).toBe(ViewType.WORLDVIEW);
    expect(next.pointer).toBe(`deployment/${ROOT_ID}`);
    expect(next.options?.selected).toBe(`deployment-${CHILD_ID}`);
  });

  it('round-trips the color mode and preserves it across selection navigation', () => {
    navigationState.currentDock = DockPointer.forWorldView(new TypeId('deployment', ROOT_ID), {
      color: 'footprint',
      depth: 4,
    });
    const { result } = renderHook(() => useGraphUrlState('worldview'));

    expect(result.current.state.color).toBe('footprint');
    act(() => result.current.setState({ selected: `deployment-${CHILD_ID}` }));

    const next = openDock.mock.calls[0][0] as DockPointer;
    expect(next.toUrl()).toBe(
      `/dock/worldview/deployment/${ROOT_ID}?color=footprint&depth=4&selected=deployment-${CHILD_ID}`,
    );
  });

  it('omits the default type mode and rejects an unknown URL color', () => {
    navigationState.currentDock = new DockPointer(
      ViewType.WORLDVIEW,
      `deployment/${ROOT_ID}`,
      { color: 'degree' },
    );
    const { result } = renderHook(() => useGraphUrlState('worldview'));

    expect(result.current.state.color).toBe('type');
    act(() => result.current.setState({ color: 'type' }));

    const next = openDock.mock.calls[0][0] as DockPointer;
    expect(next.options?.color).toBeUndefined();
    expect(next.toUrl()).toBe(`/dock/worldview/deployment/${ROOT_ID}`);
  });
});

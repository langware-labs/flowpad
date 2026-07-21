import { act, renderHook } from '@testing-library/react';
import { PageId, TypeId, ViewType, WorldViewProjection } from '@sdk';
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
const ROOT = `deployment-${ROOT_ID}`;

describe('WorldView URL-first state', () => {
  beforeEach(() => {
    openDock.mockClear();
    navigationState.currentDock = DockPointer.forWorldView(WorldViewProjection.DEPLOYMENT, { focus: ROOT });
  });

  it('keeps selection inside the one deployment projection tab', () => {
    const { result } = renderHook(() => useGraphUrlState('worldview'));

    expect(result.current.state).toMatchObject({
      projection: 'deployment',
      focus: ROOT,
      signal: 'type',
    });
    act(() => result.current.setState({ selected: `deployment-${CHILD_ID}` }));

    const next = openDock.mock.calls[0][0] as DockPointer;
    expect(next.viewType).toBe(ViewType.WORLDVIEW);
    expect(next.pointer).toBe('deployment');
    expect(next.targetTypeId?.toString()).toBe(ROOT);
    expect(next.options?.selected).toBe(`deployment-${CHILD_ID}`);
  });

  it('round-trips signal, depth, search, and sorted hidden types', () => {
    navigationState.currentDock = DockPointer.forWorldView(WorldViewProjection.DEPLOYMENT, {
      focus: ROOT,
      signal: 'footprint',
      depth: 4,
      hidden: ['user', 'artifact'],
      query: 'cloud run',
    });
    const { result } = renderHook(() => useGraphUrlState('worldview'));

    expect(result.current.state.signal).toBe('footprint');
    expect([...result.current.state.hidden]).toEqual(['artifact', 'user']);
    act(() => result.current.setState({ selected: `deployment-${CHILD_ID}` }));

    const next = openDock.mock.calls[0][0] as DockPointer;
    expect(next.toUrl()).toBe(
      `/dock/worldview/deployment?focus=${ROOT}&selected=deployment-${CHILD_ID}&signal=footprint&hide=artifact%2Cuser&q=cloud+run`,
    );
  });

  it('preserves the Hub page and projection without backend-specific state', () => {
    navigationState.currentDock = new DockPointer(
      ViewType.WORLDVIEW,
      WorldViewProjection.ORGANIZATION,
      { signal: 'cost' },
      undefined,
      PageId.HUB,
    );
    const { result } = renderHook(() => useGraphUrlState('worldview'));

    expect(result.current.state.signal).toBe('type');

    act(() => result.current.setState({ selected: `user-${CHILD_ID}` }));

    const next = openDock.mock.calls[0][0] as DockPointer;
    expect(next.page).toBe(PageId.HUB);
    expect(next.toUrl()).toBe(`/dock/hub/worldview/organization?selected=user-${CHILD_ID}`);
  });
});

describe('dependency graph URL-first state', () => {
  beforeEach(() => {
    openDock.mockClear();
    navigationState.currentDock = DockPointer.forGraph(new TypeId('deployment', ROOT_ID), {
      hidden: ['user', 'artifact'],
      query: 'cloud run',
    });
  });

  it('preserves search and type filters when selection changes', () => {
    const { result } = renderHook(() => useGraphUrlState('dependency'));

    expect([...result.current.state.hidden]).toEqual(['artifact', 'user']);
    expect(result.current.state.query).toBe('cloud run');
    act(() => result.current.setState({ selected: `deployment-${CHILD_ID}` }));

    const next = openDock.mock.calls[0][0] as DockPointer;
    expect(next.options).toMatchObject({
      selected: `deployment-${CHILD_ID}`,
      hide: 'artifact,user',
      q: 'cloud run',
    });
  });
});

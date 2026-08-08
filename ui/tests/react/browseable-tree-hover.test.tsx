import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Browseable, BrowseableRoot } from '@src/components/browseable-tree/types';
import { BrowseableTree } from '@src/components/browseable-tree/BrowseableTree';

// The tree resolves clicks through openBrowseable, which needs no provider; the
// only ambient dependency is the open-tab set.
vi.mock('@src/tabs/useTabs', () => ({ useOpenTabHashes: () => new Set<string>() }));

/** The row element that owns the hover handlers — `pointerenter` does not
 *  bubble, so firing on the label would no-op and every negative assertion here
 *  would pass vacuously. */
const rowOf = (label: string): Element =>
  screen.getByText(label).closest('[role="treeitem"]')!;

// Two jsdom facts this has to work around, or every negative assertion below
// passes for the wrong reason:
//  1. React synthesizes onPointerEnter/Leave from pointerover/pointerout, so a
//     raw `pointerenter` never reaches the handler.
//  2. jsdom implements no PointerEvent, so fireEvent.pointerOver delivers
//     pointerType `null` — which the production mouse-only guard correctly
//     rejects. Dispatch a native event carrying pointerType instead.
const pointerEvent = (type: string, pointerType: string) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'pointerType', { value: pointerType });
  return e;
};
const hover = (label: string, pointerType = 'mouse') =>
  fireEvent(rowOf(label), pointerEvent('pointerover', pointerType));
const unhover = (label: string, pointerType = 'mouse') =>
  fireEvent(rowOf(label), pointerEvent('pointerout', pointerType));

function root(over: Partial<BrowseableRoot>): BrowseableRoot {
  return {
    id: 'r1',
    kind: 'root',
    label: 'Folder',
    hasChildren: true,
    pointer: null,
    listChildren: () => Promise.resolve([]),
    ownsPointer: () => false,
    pathFor: () => Promise.resolve([]),
    ...over,
  };
}

/** A childless row with a pointer arm — the shape every leaf test needs, so the
 *  `as never` pointer escape lives in exactly one place. */
const leaf = (over: Partial<Browseable>): BrowseableRoot =>
  root({
    id: 'leaf',
    label: 'Welcome',
    hasChildren: false,
    listChildren: undefined,
    pointer: { viewType: 'editor', pointer: 'x' } as never,
    ...over,
  });

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('BrowseableTree hover-expand', () => {
  it('does nothing on hover when hoverExpandMs is unset — the default for every other navigator', () => {
    const listChildren = vi.fn(() => Promise.resolve([] as Browseable[]));
    render(<BrowseableTree roots={[root({ listChildren })]} activePointer={null} />);

    hover('Folder');
    act(() => void vi.advanceTimersByTime(2000));

    expect(listChildren).not.toHaveBeenCalled();
  });

  it('expands after the dwell when hoverExpandMs is set', () => {
    const listChildren = vi.fn(() => Promise.resolve([] as Browseable[]));
    render(<BrowseableTree roots={[root({ listChildren })]} activePointer={null} hoverExpandMs={150} />);

    hover('Folder');
    act(() => void vi.advanceTimersByTime(149));
    expect(listChildren).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(1));
    expect(listChildren).toHaveBeenCalled();
  });

  it('leaving before the dwell cancels the expand', () => {
    const listChildren = vi.fn(() => Promise.resolve([] as Browseable[]));
    render(<BrowseableTree roots={[root({ listChildren })]} activePointer={null} hoverExpandMs={150} />);

    hover('Folder');
    act(() => void vi.advanceTimersByTime(100));
    unhover('Folder');
    act(() => void vi.advanceTimersByTime(2000));

    expect(listChildren).not.toHaveBeenCalled();
  });

  it('ignores touch — a tap must not expand', () => {
    const listChildren = vi.fn(() => Promise.resolve([] as Browseable[]));
    render(<BrowseableTree roots={[root({ listChildren })]} activePointer={null} hoverExpandMs={150} />);

    hover('Folder', 'touch');
    act(() => void vi.advanceTimersByTime(2000));

    expect(listChildren).not.toHaveBeenCalled();
  });
});

describe('BrowseableTree hover-seen', () => {
  it('does nothing on hover when hoverSeenMs is unset — the default for every other navigator', () => {
    const onHoverSeen = vi.fn();
    render(<BrowseableTree roots={[leaf({ onHoverSeen })]} activePointer={null} />);

    hover('Welcome');
    act(() => void vi.advanceTimersByTime(5000));

    expect(onHoverSeen).not.toHaveBeenCalled();
  });

  it('fires after the dwell when hoverSeenMs is set', () => {
    const onHoverSeen = vi.fn();
    render(<BrowseableTree roots={[leaf({ onHoverSeen })]} activePointer={null} hoverSeenMs={250} />);

    hover('Welcome');
    act(() => void vi.advanceTimersByTime(249));
    expect(onHoverSeen).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(1));
    expect(onHoverSeen).toHaveBeenCalledTimes(1);
  });

  it('a pointer sweeping past cancels it — the badges survive a pass down the menu', () => {
    const onHoverSeen = vi.fn();
    render(<BrowseableTree roots={[leaf({ onHoverSeen })]} activePointer={null} hoverSeenMs={250} />);

    hover('Welcome');
    act(() => void vi.advanceTimersByTime(100));
    unhover('Welcome');
    act(() => void vi.advanceTimersByTime(5000));

    expect(onHoverSeen).not.toHaveBeenCalled();
  });

  it('re-fires on a second dwell — the stamp, not the tree, owns the dedupe', () => {
    const onHoverSeen = vi.fn();
    render(<BrowseableTree roots={[leaf({ onHoverSeen })]} activePointer={null} hoverSeenMs={250} />);

    hover('Welcome');
    act(() => void vi.advanceTimersByTime(250));
    unhover('Welcome');
    hover('Welcome');
    act(() => void vi.advanceTimersByTime(250));

    expect(onHoverSeen).toHaveBeenCalledTimes(2);
  });

  it('ignores touch — a tap must not stamp', () => {
    const onHoverSeen = vi.fn();
    render(<BrowseableTree roots={[leaf({ onHoverSeen })]} activePointer={null} hoverSeenMs={250} />);

    hover('Welcome', 'touch');
    act(() => void vi.advanceTimersByTime(5000));

    expect(onHoverSeen).not.toHaveBeenCalled();
  });
});

describe('BrowseableTree hover never opens', () => {
  // Hover marks a row SEEN (onHoverSeen, above); it must still never OPEN it.
  // `onOpen` is the usage stamp that counts a real visit and the arm that
  // navigates — firing either on hover would make a pass down the menu look
  // like a pass through every bookmark.
  it('hovering a leaf does NOT open it or mark it read', () => {
    const onOpen = vi.fn();
    const onNavigate = vi.fn();
    render(
      <BrowseableTree roots={[leaf({ onOpen })]} activePointer={null} onNavigate={onNavigate} hoverExpandMs={150} />,
    );

    hover('Welcome');
    act(() => void vi.advanceTimersByTime(5000));

    expect(onOpen).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('clicking a leaf opens it exactly once', () => {
    const onOpen = vi.fn();
    const onNavigate = vi.fn();
    render(
      <BrowseableTree roots={[leaf({ onOpen })]} activePointer={null} onNavigate={onNavigate} hoverExpandMs={150} />,
    );

    fireEvent.click(screen.getByText('Welcome'));

    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

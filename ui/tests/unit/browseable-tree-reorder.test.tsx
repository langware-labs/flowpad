/** A leaf in a container that orders its children takes a drop on its edge: before or after it. */
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowseableTree } from '@src/components/browseable-tree/BrowseableTree';
import type { Browseable, BrowseableRoot } from '@src/components/browseable-tree/types';

afterEach(() => cleanup());

const leaf = (id: string): Browseable => ({
  id: `row-${id}`,
  kind: 'asset',
  label: id,
  hasChildren: false,
  pointer: null,
  dragData: { kind: 'leaf', id, label: id },
});

it('a drop on the lower half of a sibling reorders after it, on the upper half before it', async () => {
  const reorderChildren = vi.fn();
  const root: BrowseableRoot = {
    id: 'root',
    kind: 'root',
    label: 'Root',
    hasChildren: 'unknown',
    pointer: null,
    listChildren: () => Promise.resolve([leaf('a'), leaf('b')]),
    reorderChildren,
    ownsPointer: () => false,
    pathFor: () => Promise.resolve([]),
  };
  render(<BrowseableTree roots={[root]} activePointer={null} defaultExpandedIds={['root']} persistKey="t.reorder" />);
  const row = async (name: string) => (await screen.findByText(name)).closest('[role="treeitem"]') as HTMLElement;
  const [a, b] = [await row('a'), await row('b')];
  const dataTransfer = { setData: vi.fn(), getData: () => '', types: [], setDragImage: vi.fn() };
  b.getBoundingClientRect = () => ({ top: 0, height: 20 }) as DOMRect;
  // jsdom's drag events carry no pointer position, so it is set on the event.
  const on = (type: 'dragOver' | 'drop', clientY: number) => {
    const event = createEvent[type](b, { dataTransfer });
    Object.defineProperty(event, 'clientY', { value: clientY });
    fireEvent(b, event);
  };

  fireEvent.dragStart(a, { dataTransfer });
  on('dragOver', 15);
  expect(screen.getByTestId('browseable-drop-after')).toBeTruthy();
  on('drop', 15);
  expect(reorderChildren).toHaveBeenLastCalledWith('a', { afterId: 'b' });
  await act(async () => {}); // the first drop ends its drag

  fireEvent.dragStart(a, { dataTransfer });
  on('drop', 3);
  expect(reorderChildren).toHaveBeenLastCalledWith('a', { beforeId: 'b' });
});

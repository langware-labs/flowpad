/**
 * BrowseableTree gestures that drive file-manager actions: the right-click
 * menu, F2 / Delete / ⌘C on a focused row, and Alt-drop meaning copy.
 */
import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BrowseableTree, createMockBrowseable, mockPointerFor } from '@src/components/browseable-tree';
import type { Browseable, BrowseableRoot } from '@src/components/browseable-tree';

function rootWith(children: Browseable[]): BrowseableRoot {
  const root: BrowseableRoot = {
    id: 'root',
    kind: 'root',
    label: 'Root',
    hasChildren: true,
    pointer: mockPointerFor('root'),
    listChildren: () => Promise.resolve(children),
    ownsPointer: () => false,
    pathFor: () => Promise.resolve([root]),
  };
  return root;
}

async function renderTree(children: Browseable[]) {
  render(<BrowseableTree roots={[rootWith(children)]} activePointer={null} defaultExpandedIds={['root']} />);
  for (const c of children) await screen.findByText(c.label);
}

const row = (label: string) => screen.getByText(label).closest('[role="treeitem"]') as HTMLElement;

describe('BrowseableTree file gestures', () => {
  it('right-click opens the row menu; an item runs with the row', async () => {
    const run = vi.fn();
    const leaf = createMockBrowseable({
      id: 'a',
      label: 'a.md',
      hasChildren: false,
      contextMenu: () => [{ id: 'dup', icon: null, label: 'Duplicate', run }],
    });
    await renderTree([leaf]);
    fireEvent.contextMenu(row('a.md'));
    await userEvent.click(await screen.findByTestId('browseable-menu-dup'));
    expect(run).toHaveBeenCalledWith([leaf]);
  });

  it('a disabled menu item does not run', async () => {
    const run = vi.fn();
    const leaf = createMockBrowseable({
      id: 'a',
      label: 'a.md',
      hasChildren: false,
      contextMenu: [{ id: 'paste', icon: null, label: 'Paste', disabled: () => true, run }],
    });
    await renderTree([leaf]);
    fireEvent.contextMenu(row('a.md'));
    const item = await screen.findByTestId('browseable-menu-paste');
    expect(item.getAttribute('data-disabled')).not.toBeNull();
    await userEvent.click(item).catch(() => {});
    expect(run).not.toHaveBeenCalled();
  });

  it('the menu Rename item opens the inline rename', async () => {
    const onRename = vi.fn();
    const leaf = createMockBrowseable({
      id: 'a',
      label: 'a.md',
      hasChildren: false,
      onRename,
      contextMenu: [{ id: 'rename', icon: null, label: 'Rename', startsRename: true, run: () => {} }],
    });
    await renderTree([leaf]);
    fireEvent.contextMenu(row('a.md'));
    await userEvent.click(await screen.findByTestId('browseable-menu-rename'));
    const input = await screen.findByTestId('browseable-rename-a');
    await userEvent.clear(input);
    await userEvent.type(input, 'b.md{Enter}');
    expect(onRename).toHaveBeenCalledWith('b.md');
  });

  it('F2 renames, Delete and ⌘C run the row key actions', async () => {
    const del = vi.fn();
    const copy = vi.fn();
    const leaf = createMockBrowseable({
      id: 'a',
      label: 'a.md',
      hasChildren: false,
      onRename: vi.fn(),
      keyActions: { delete: del, copy },
    });
    await renderTree([leaf]);
    const r = row('a.md');
    fireEvent.keyDown(r, { key: 'Delete' });
    expect(del).toHaveBeenCalledWith([leaf]);
    fireEvent.keyDown(r, { key: 'c', metaKey: true });
    expect(copy).toHaveBeenCalledWith([leaf]);
    fireEvent.keyDown(r, { key: 'F2' });
    expect(await screen.findByTestId('browseable-rename-a')).toBeTruthy();
  });

  it('dropping with Alt held asks for a copy', async () => {
    const onDrop = vi.fn();
    const file = createMockBrowseable({
      id: 'f',
      label: 'f.md',
      hasChildren: false,
      dragData: { kind: 'test', id: 'f', label: 'f.md' },
    });
    const folder = createMockBrowseable({ id: 'd', label: 'dir', hasChildren: false, onDrop });
    await renderTree([folder, file]);
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(), types: [], dropEffect: '', effectAllowed: '' };
    fireEvent.dragStart(row('f.md'), { dataTransfer });
    // jsdom has no DragEvent, so modifier keys in the init are dropped: set it on the event.
    const withAlt = (ev: Event) => Object.defineProperty(ev, 'altKey', { value: true }) as Event;
    fireEvent(row('dir'), withAlt(createEvent.dragOver(row('dir'), { dataTransfer })));
    fireEvent(row('dir'), withAlt(createEvent.drop(row('dir'), { dataTransfer })));
    await waitFor(() => expect(onDrop).toHaveBeenCalledWith(file.dragData, { copy: true }));
  });

  it('a file with a download url can be dragged out of the app', async () => {
    const file = createMockBrowseable({
      id: 'f',
      label: 'f.md',
      hasChildren: false,
      dragData: { kind: 'test', id: 'f', label: 'f.md' },
      downloadUrl: 'http://x/dl/f.md',
    });
    await renderTree([file]);
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(), types: [], dropEffect: '', effectAllowed: '' };
    fireEvent.dragStart(row('f.md'), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith('DownloadURL', 'application/octet-stream:f.md:http://x/dl/f.md');
  });
});

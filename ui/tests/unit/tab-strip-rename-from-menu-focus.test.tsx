/**
 * Rename chosen from a chip's context menu must leave the caret IN the rename input.
 *
 * The editor used to open inside the menu item's onSelect, while the menu's focus trap was live: the trap
 * pulled focus back, the input's blur committed the unchanged name and closed the editor, so choosing
 * Rename did nothing (shell_tab_title_and_switch timed out on press('Enter') with no input left).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabStrip, type TabStripItem } from '@src/components/tabs/TabStrip';

const items: TabStripItem[] = [
  { key: 't0', title: 'Tab 1', renameable: true },
  { key: 't1', title: 'Tab 2', renameable: true },
];

afterEach(cleanup);

describe('TabStrip rename from the context menu', () => {
  it('focuses and selects the rename input once the menu has closed', async () => {
    const onRename = vi.fn();
    render(
      <MemoryRouter>
        <TabStrip items={items} activeKey="t0" onSelect={() => {}} onClose={() => {}} onRename={onRename} />
      </MemoryRouter>,
    );
    const chip = screen.getByTestId('terminal-tabs-row').querySelector<HTMLElement>('[data-terminal-target="t1"]')!;
    fireEvent.contextMenu(chip);
    // Enter selects a menu item the way Radix handles it in jsdom (a bare synthetic click does not).
    const item = await screen.findByRole('menuitem', { name: 'Rename' });
    item.focus();
    fireEvent.keyDown(item, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    // Queried fresh: the chip re-renders into its editing form.
    const input = await waitFor(() => {
      const found = document.querySelector<HTMLInputElement>('[data-terminal-target="t1"] input[type="text"]');
      expect(found).not.toBeNull();
      return found!;
    });
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    // ...and choosing Rename committed nothing on its own (the blur used to commit the unchanged name).
    expect(onRename).not.toHaveBeenCalled();
  });
});

/**
 * The source row's ⋯ menu is the four verbs a source is driven with — Pull, Pause, Edit, Delete. Everything
 * rarer (replaying history, the files behind the source, the Events and Runs surfaces) sits under Advanced,
 * so the menu reads at a glance and nothing is lost.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DataDriver } from '@sdk';
import { fakeSource } from './fake-source';

vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: { openDock: vi.fn() } }) }));
vi.mock('@src/hooks/flow-hooks', () => ({ useAssetApps: () => [] }));
vi.mock('@src/components/data-sources/OpenFolderButton', () => ({ revealFolder: vi.fn() }));

import { SourceMenu } from '@src/components/data-sources/SourceMenu';

const noop = () => {};

afterEach(cleanup);

it('shows the four verbs, and the rest under Advanced', async () => {
  const source = fakeSource('m', 'slack', { asset_ref: '/tmp/src' });
  const spec = new DataDriver({ name: 'slack', asset_ref: '/tmp/driver' } as never);
  render(
    <SourceMenu source={source} spec={spec} onPull={noop} onToggleEnabled={noop} onEdit={noop} onReplay={noop} onDelete={noop} />,
  );
  // Radix menus open on pointerdown, not click (and on Enter when the pointer did not count).
  const trigger = screen.getByTestId(`source-more-${source.id}`);
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.keyDown(trigger, { key: 'Enter' });
  const menu = await screen.findByRole('menu');
  const topLevel = Array.from(menu.children)
    .filter((e) => e.getAttribute('role') === 'menuitem')
    .map((e) => e.textContent?.trim());
  expect(topLevel).toEqual(['Pull changes now', 'Pause', 'Edit', 'Advanced', 'Delete']);
  for (const hidden of ['Replay…', 'Open data_source.json', 'Open source folder', 'Open driver folder', 'Events on the bus', 'Runs']) {
    expect(screen.queryByText(hidden)).toBeNull();
  }

  const advanced = screen.getByTestId(`source-advanced-${source.id}`);
  advanced.focus();
  fireEvent.keyDown(advanced, { key: 'ArrowRight' });
  if (!screen.queryByText('Replay…')) fireEvent.pointerMove(advanced, { pointerType: 'mouse' });
  await waitFor(() => expect(screen.getByText('Replay…')).toBeInTheDocument());
  const sub = screen.getByText('Replay…').closest('[role="menu"]') as HTMLElement;
  const underAdvanced = Array.from(sub.querySelectorAll('[role="menuitem"]')).map((e) => e.textContent?.trim());
  expect(underAdvanced).toEqual(['Replay…', 'Open data_source.json', 'Open source folder', 'Open driver folder', 'Events on the bus', 'Runs']);
});

/**
 * RCA capture (proven this session): toggling the View pill (Standard ⇄ Advanced)
 * moves the selected tab header sideways. The mechanism is that each chip's
 * "Open in external browser" button is gated on `isAdvanced` (TabStrip.tsx:442),
 * so every chip is ~24px wider in Advanced (button rendered, opacity-0 but still
 * occupying layout) and has no such button in Standard. The cumulative width of
 * the chips before the selected one therefore changes with the view mode, and
 * the selected tab shifts (measured live: selected chip x=1109 in Standard →
 * x=1277 in Advanced, exactly 7 preceding chips × 24px).
 *
 * jsdom has no layout engine, so we capture the bug at its proven source: a
 * chip's set of layout-occupying elements must be view-mode-invariant. The
 * open-external button must not appear in one mode and vanish in the other.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabStrip, type TabStripItem } from '@src/components/tabs/TabStrip';
import { ViewMode, setViewMode } from '@src/contexts/view-mode-context';

// `view-mode-context` reads the current dock, which calls `useLocation()`.
// These tests render without a Router, so stub only that hook and keep the
// rest of the module real (a full mock would drop `useDockNavigation`).
vi.mock('@src/navigation/useDockNavigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/navigation/useDockNavigation')>()),
  useCurrentDock: () => null,
}));


const items: TabStripItem[] = [
  { key: 'a', title: 'Alpha' },
  { key: 'b', title: 'Bravo' },
  { key: 'c', title: 'Charlie' },
];

function renderStrip() {
  return render(
    <TabStrip items={items} activeKey="c" onSelect={() => {}} onClose={() => {}} onPopout={() => {}} />,
  );
}

const externalButtonCount = () =>
  screen.queryAllByRole('button', { name: /open in external browser/i }).length;

describe('TabStrip chip composition is view-mode invariant', () => {
  afterEach(() => {
    cleanup();
    setViewMode(ViewMode.Standard);
  });

  it('renders the same per-chip layout elements in Standard and Advanced', () => {
    setViewMode(ViewMode.Standard);
    renderStrip();
    const standardCount = externalButtonCount();
    cleanup();

    setViewMode(ViewMode.Advanced);
    renderStrip();
    const advancedCount = externalButtonCount();

    // If the open-external button exists in one mode but not the other, every
    // chip's width changes with the view mode and the selected tab shifts.
    expect(standardCount).toBe(advancedCount);
  });
});

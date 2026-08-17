/**
 * The last crumb's details popover — where the asset editor's header row went.
 *
 * The header showed the real filename, the path, a copy button and a reveal
 * glyph. All of that had to survive the row's deletion, so this pins the four
 * things it must still offer, and the one case where it must not appear at all.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const openDock = vi.hoisted(() => vi.fn());
const copyToClipboard = vi.hoisted(() => vi.fn());
const fsOpen = vi.hoisted(() => vi.fn());
const localNode = vi.hoisted(() => ({ id: 'local' as string | null }));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock }, currentDock: null }),
}));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    copyToClipboard,
    // A stand-in for the reveal target: `localComputeNodeId` is the real gate,
    // and it is null for an asset that lives on another machine.
    FSRef: class {
      constructor(
        public path: string,
        public typeId: unknown,
      ) {}
      get localComputeNodeId() {
        return localNode.id;
      }
      open = fsOpen;
    },
  };
});

import { CrumbDetailsPopover } from '@src/components/top-nav-bar/CrumbDetailsPopover';

const PATH = '/Users/me/Flowpad workspace/proj/docs/chip_demo.md';

function open(props: Partial<{ filename: string | null; path: string }> = {}) {
  render(
    <CrumbDetailsPopover label="chip_demo" filename="chip_demo.md" path={PATH} {...props}>
      <button type="button">chip_demo</button>
    </CrumbDetailsPopover>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'chip_demo' }));
}

beforeEach(() => {
  localNode.id = 'local';
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('the crumb details popover', () => {
  it('shows the real filename, with the extension the crumb drops', () => {
    open();

    // The crumb label is the display name ("chip_demo"); this is the file.
    expect(screen.getByText('chip_demo.md')).toBeTruthy();
  });

  it('copies the FULL file path, not the folder', () => {
    // The old header displayed the parent dir but copied the file path. Keep it.
    open();

    fireEvent.click(screen.getByTestId('top-nav-crumb-copy-path'));

    expect(copyToClipboard).toHaveBeenCalledWith(PATH);
  });

  it('opens the containing folder in the in-app Files view', () => {
    open();

    fireEvent.click(screen.getByTestId('top-nav-crumb-open-files'));

    expect(openDock).toHaveBeenCalledTimes(1);
    const pointer = openDock.mock.calls[0][0] as { pointer?: string };
    expect(pointer.pointer).toBe('/Users/me/Flowpad workspace/proj/docs');
  });

  it('reveals the file in the OS file manager, selected', () => {
    open();

    fireEvent.click(screen.getByTestId('top-nav-crumb-reveal'));

    expect(fsOpen).toHaveBeenCalledWith({ select: true });
  });

  it('hides reveal for an asset on another machine', () => {
    localNode.id = null;
    open();

    expect(screen.queryByTestId('top-nav-crumb-reveal')).toBeNull();
    // Files still works — it navigates in-app, no local machine involved.
    expect(screen.getByTestId('top-nav-crumb-open-files')).toBeTruthy();
  });

  it('falls back to the crumb label when there is no filename', () => {
    open({ filename: null });

    // Scoped to the popover — the trigger carries the same text.
    expect(screen.getByTestId('top-nav-crumb-details').textContent).toContain('chip_demo');
  });
});

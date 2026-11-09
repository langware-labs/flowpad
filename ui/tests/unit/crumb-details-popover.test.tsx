/**
 * The last crumb's details popover — where the asset editor's header row went.
 *
 * The header showed the real filename, the path, a copy button and a reveal
 * glyph. All of that had to survive the row's deletion, so this pins the four
 * things it must still offer, and the one case where it must not appear at all.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

// The tag control loads its entity; here only its text field matters.
vi.mock('@src/components/tags/EntityTags', () => ({
  EntityTags: () => <input data-testid="tag-field" />,
}));

import { CrumbDetailsPopover } from '@src/components/top-nav-bar/CrumbDetailsPopover';
import { dataContext, RuntimeKind, TypeId } from '@sdk';

const PATH = '/Users/me/Flowpad workspace/proj/docs/chip_demo.md';

function mount(props: Partial<{ filename: string | null; path: string; directory: boolean; typeId: TypeId }> = {}) {
  render(
    <CrumbDetailsPopover label="chip_demo" filename="chip_demo.md" path={PATH} {...props}>
      <button type="button">chip_demo</button>
    </CrumbDetailsPopover>,
  );
  return screen.getByRole('button', { name: 'chip_demo' });
}

/** Click is the SYNCHRONOUS way in; hover is what the user does, pinned separately. */
function open(props: Partial<{ filename: string | null; path: string; directory: boolean }> = {}) {
  fireEvent.click(mount(props));
}

/** Radix arms its outside-dismiss listener a tick after the card opens; let it. */
async function armDismissal() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  localNode.id = 'local';
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('the crumb details popover', () => {
  it('opens on hover, like the project crumb card beside it', async () => {
    const user = userEvent.setup();
    const trigger = mount();
    expect(screen.queryByTestId('top-nav-crumb-details')).toBeNull();

    await user.hover(trigger);

    expect(await screen.findByTestId('top-nav-crumb-details')).toBeTruthy();
  });

  it('stays closed after Escape when it was hovered and then clicked open', async () => {
    // Radix arms its hover-open timer on pointerenter; a click inside openDelay
    // opens the card first, and the stale timer used to re-open it right after
    // Escape dismissed it — no new hover, no new focus.
    const user = userEvent.setup();
    const trigger = mount();
    await user.hover(trigger);
    fireEvent.click(trigger);
    expect(screen.getByTestId('top-nav-crumb-details')).toBeTruthy();
    await armDismissal();

    await user.keyboard('{Escape}');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    expect(screen.queryByTestId('top-nav-crumb-details')).toBeNull();
  });

  it('opens a FOLDER crumb in Files as itself, and reveals it without selecting', () => {
    const folder = { filename: null, path: '/Users/me/Flowpad workspace/proj', directory: true };
    open(folder);

    fireEvent.click(screen.getByTestId('top-nav-crumb-open-files'));
    const pointer = openDock.mock.calls[0][0] as { pointer?: string };
    expect(pointer.pointer).toBe('/Users/me/Flowpad workspace/proj');

    // Acting on the card dismisses it, so reveal needs its own opening.
    cleanup();
    open(folder);
    fireEvent.click(screen.getByTestId('top-nav-crumb-reveal'));
    expect(fsOpen).toHaveBeenCalledWith(undefined);
  });

  it('closes on a click anywhere outside it', async () => {
    open();
    expect(screen.getByTestId('top-nav-crumb-details')).toBeTruthy();

    await armDismissal();
    fireEvent.pointerDown(document.body);

    await waitFor(() => expect(screen.queryByTestId('top-nav-crumb-details')).toBeNull());
  });

  it('stays open while its tag field is being typed in, and still closes on a click outside', async () => {
    // A hover card closes when the pointer leaves it — which would throw away
    // a half-typed tag the moment the mouse drifted off the card.
    const user = userEvent.setup();
    const trigger = mount({ typeId: new TypeId('markdown', '0b6f3c1e-5a52-4f0e-9d0b-6f1f6f0f3a11') });
    await user.hover(trigger);
    const field = await screen.findByTestId('tag-field');

    await user.click(field);
    await user.type(field, 'meeting');
    await user.hover(document.body);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect((screen.getByTestId('tag-field') as HTMLInputElement).value).toBe('meeting');

    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByTestId('top-nav-crumb-details')).toBeNull());
  });

  it('closes when the click lands INSIDE an embedded frame', async () => {
    // The html preview, a webapp display and the deck viewer are iframes: a
    // click in one never reaches this document, so the outside-pointerdown
    // dismiss is blind to it. Losing focus to the frame is the signal that
    // crosses the boundary. This is the shape the bug was reported in — the
    // card sat over an .html preview and no click would shift it.
    open();
    await armDismissal();

    const frame = document.body.appendChild(document.createElement('iframe'));
    frame.focus();
    fireEvent.blur(window);

    await waitFor(() => expect(screen.queryByTestId('top-nav-crumb-details')).toBeNull());
  });

  it('closes on a SECOND click on the crumb', async () => {
    // Radix dismisses on the pointer-down (the trigger is outside the card), so
    // a naive `setOpen(!open)` on the click that follows would re-open it.
    const trigger = mount();
    fireEvent.click(trigger);
    await armDismissal();

    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);

    await waitFor(() => expect(screen.queryByTestId('top-nav-crumb-details')).toBeNull());
  });

  it('closes once you act on it — the card is gone behind the navigation', () => {
    open();

    fireEvent.click(screen.getByTestId('top-nav-crumb-open-files'));

    expect(screen.queryByTestId('top-nav-crumb-details')).toBeNull();
  });

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

  it.each([RuntimeKind.HUB, RuntimeKind.SANDBOX, RuntimeKind.AGENT])(
    'hides reveal on %s — no file manager reaches a person there',
    (kind) => {
      dataContext.bootstrapInfo = { runtime: { kind } } as never;
      try {
        open();
        expect(screen.queryByTestId('top-nav-crumb-reveal')).toBeNull();
      } finally {
        dataContext.bootstrapInfo = null as never;
      }
    },
  );

  it('falls back to the crumb label when there is no filename', () => {
    open({ filename: null });

    // Scoped to the popover — the trigger carries the same text.
    expect(screen.getByTestId('top-nav-crumb-details').textContent).toContain('chip_demo');
  });
});

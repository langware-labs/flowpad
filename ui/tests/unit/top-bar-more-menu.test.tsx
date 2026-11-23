/**
 * The bar's menu: the LAST control in both bar branches, after the star. Record screen starts a
 * recording (and the bar then shows the stop button with the time), Context is offered only when
 * the bar addresses something that has one, Remote control opens its panel under the menu button
 * (it never navigates), a dock carrying `remote-control=open` opens that panel on arrival, and one
 * carrying `remote-control-assertion` hands the fingerprint answer to the machine first — both
 * options leave the address in one history replace.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rec = vi.hoisted(() => ({
  state: { phase: 'idle', busy: false, startedAt: null as number | null, recording: null as unknown },
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
}));
vi.mock('@src/components/top-nav-bar/use-screen-recorder', () => ({
  useScreenRecorder: () => rec.state,
  startRecording: rec.startRecording,
  stopRecording: rec.stopRecording,
  formatElapsed: (ms: number) => `00:${String(Math.floor(ms / 1000)).padStart(2, '0')}`,
}));
vi.mock('@src/components/top-nav-bar/RecordingReadyDialog', () => ({
  RecordingReadyDialog: () => <div data-testid="recording-ready-dialog" />,
}));
const nav = vi.hoisted(() => ({
  openPreferences: vi.fn(),
  openDock: vi.fn(),
  setOption: vi.fn(),
  replaceDock: vi.fn(),
  here: {
    cleared: [] as string[],
    withOption(key: string, value: string | null) {
      return { ...this, cleared: value === null ? [...this.cleared, key] : this.cleared };
    },
  },
  current: null as { remoteControlOpen: boolean; remoteControlAssertion?: string | null } | null,
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: nav }),
  useCurrentDock: () => nav.current,
}));
// The panel itself is `remote-control-panel.test.tsx`; here only where it is mounted and what the row says.
const rc = vi.hoisted(() => ({
  status: { available: true, on: false } as { available: boolean; on: boolean; open_until?: string } | null,
  reload: vi.fn(() => Promise.resolve()),
  confirm: vi.fn(() => Promise.resolve()),
}));
vi.mock('@src/components/remote-control/RemoteControlPanel', () => ({
  useRemoteControl: () => rc,
  RemoteControlTimeLeft: ({ until }: { until: string }) => <span>{until}</span>,
  RemoteControlPanel: () => <div data-testid="remote-control-section" />,
}));
vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => false }));
vi.mock('@src/components/graph-view/icons/iconRegistry', () => ({ iconForType: () => () => null }));
// The context list itself is `context-menu-button.test.tsx`; here only that the menu opens it.
vi.mock('@src/components/entity-actions/ContextMenuButton', () => ({
  contextMenuAvailable: () => true,
  ContextMenuButton: ({ open }: { open?: boolean }) => (open ? <div data-testid="context-menu" /> : null),
}));
// The bar's other members: stubs that only need to be findable in order.
vi.mock('@src/components/entity-actions/EntityActionsToolbar', () => ({
  EntityActionsToolbar: ({ trailing }: { trailing?: React.ReactNode }) => (
    <div>
      <button data-testid="entity-actions-share">share</button>
      {trailing}
    </div>
  ),
}));
vi.mock('@src/components/top-nav-bar/PageShareButton', () => ({
  PageShareButton: () => <button data-testid="entity-actions-share">share</button>,
}));
vi.mock('@src/components/top-nav-bar/BookmarksStarButton', () => ({
  BookmarksStarButton: () => <button data-testid="top-nav-star">star</button>,
}));
vi.mock('@src/components/favorites/favorite-target', () => ({ favoriteTargetForDock: () => ({}) }));

import { TopBarActions } from '@src/components/top-nav-bar/TopBarActions';
import { TooltipProvider } from '@src/components/ui/tooltip';

const ENTITY = { toString: () => 'markdown-a1' } as never;
const PLAIN_DOCK = { transcriptSessionTypeId: null } as never;

function bar(props: { targetTypeId: unknown; dock: unknown }) {
  return render(
    <TooltipProvider>
      <TopBarActions targetTypeId={props.targetTypeId as never} targetTitle="Doc" dock={props.dock as never} />
    </TooltipProvider>,
  );
}

const follows = (a: HTMLElement, b: HTMLElement) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('TopBarMoreMenu', () => {
  beforeEach(() => {
    rec.state = { phase: 'idle', busy: false, startedAt: null, recording: null };
    rc.status = { available: true, on: false };
    nav.current = null;
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it.each([
    ['entity', { targetTypeId: ENTITY, dock: null }],
    ['dock-only', { targetTypeId: null, dock: PLAIN_DOCK }],
  ])('is the last control, after Share and the star, in the %s branch', (_name, props) => {
    bar(props);
    const buttons = screen.getAllByRole('button');
    expect(buttons[buttons.length - 1].getAttribute('data-testid')).toBe('top-nav-more');
    expect(follows(screen.getByTestId('entity-actions-share'), screen.getByTestId('top-nav-star'))).toBe(true);
    expect(follows(screen.getByTestId('top-nav-star'), screen.getByTestId('top-nav-more'))).toBe(true);
    // Record is no longer a button on the idle bar.
    expect(screen.queryByTestId('top-nav-recording-stop')).toBeNull();
  });

  it('Record screen starts a recording', async () => {
    bar({ targetTypeId: null, dock: PLAIN_DOCK });
    await userEvent.click(screen.getByTestId('top-nav-more'));
    await userEvent.click(await screen.findByTestId('top-nav-more-record'));
    expect(rec.startRecording).toHaveBeenCalledTimes(1);
  });

  it('while recording the bar shows the stop button with the time, before the cluster', async () => {
    rec.state = { phase: 'recording', busy: false, startedAt: Date.now() - 42_000, recording: null };
    bar({ targetTypeId: null, dock: PLAIN_DOCK });
    const stop = screen.getByTestId('top-nav-recording-stop');
    expect(stop.textContent).toContain('00:42');
    expect(follows(stop, screen.getByTestId('top-nav-more'))).toBe(true);
    await userEvent.click(stop);
    expect(rec.stopRecording).toHaveBeenCalledTimes(1);
    // A second recording cannot be started from the menu meanwhile.
    await userEvent.click(screen.getByTestId('top-nav-more'));
    expect((await screen.findByTestId('top-nav-more-record')).hasAttribute('data-disabled')).toBe(true);
  });

  it('the finished recording opens its dialog from the bar, with the menu closed', () => {
    rec.state = { phase: 'ready', busy: false, startedAt: null, recording: {} };
    bar({ targetTypeId: ENTITY, dock: null });
    expect(screen.getByTestId('recording-ready-dialog')).toBeTruthy();
    expect(screen.queryByTestId('top-nav-more-record')).toBeNull();
  });

  it('Context is offered for an entity and opens its list; a plain page has none', async () => {
    const entity = bar({ targetTypeId: ENTITY, dock: null });
    await userEvent.click(screen.getByTestId('top-nav-more'));
    await userEvent.click(await screen.findByTestId('top-nav-more-context'));
    expect(await screen.findByTestId('context-menu')).toBeTruthy();
    entity.unmount();

    bar({ targetTypeId: null, dock: PLAIN_DOCK });
    await userEvent.click(screen.getByTestId('top-nav-more'));
    await screen.findByTestId('top-nav-more-record');
    expect(screen.queryByTestId('top-nav-more-context')).toBeNull();
  });

  it('each row is its name with a muted detail at the right: "this window", and remote control on / off', async () => {
    const off = bar({ targetTypeId: null, dock: PLAIN_DOCK });
    await userEvent.click(screen.getByTestId('top-nav-more'));
    expect((await screen.findByTestId('top-nav-more-record')).textContent).toBe('Record screenthis window');
    expect(screen.getByTestId('top-nav-more-remote-control').textContent).toBe('Remote controloff');
    off.unmount();

    rc.status = { available: true, on: true };
    const on = bar({ targetTypeId: null, dock: PLAIN_DOCK });
    await userEvent.click(screen.getByTestId('top-nav-more'));
    expect((await screen.findByTestId('top-nav-more-remote-control')).textContent).toBe('Remote controlon');
    on.unmount();

    // Not read yet, or not available on this machine: the row says nothing rather than guess.
    rc.status = null;
    bar({ targetTypeId: null, dock: PLAIN_DOCK });
    await userEvent.click(screen.getByTestId('top-nav-more'));
    expect((await screen.findByTestId('top-nav-more-remote-control')).textContent).toBe('Remote control');
  });

  it('Remote control opens its panel under the menu button and does not navigate', async () => {
    bar({ targetTypeId: null, dock: PLAIN_DOCK });
    expect(screen.queryByTestId('top-nav-remote-control-panel')).toBeNull();
    await userEvent.click(screen.getByTestId('top-nav-more'));
    await userEvent.click(await screen.findByTestId('top-nav-more-remote-control'));
    const panel = await screen.findByTestId('top-nav-remote-control-panel');
    expect(panel.querySelector('[data-testid="remote-control-section"]')).toBeTruthy();
    // The menu is gone, the panel stays.
    expect(screen.queryByTestId('top-nav-more-record')).toBeNull();
    expect(nav.openPreferences).not.toHaveBeenCalled();
    expect(nav.openDock).not.toHaveBeenCalled();
    expect(nav.setOption).not.toHaveBeenCalled();
  });

  it('a dock carrying remote-control=open opens the panel on arrival, once, and clears the option by a replace', async () => {
    nav.current = { remoteControlOpen: true };
    const view = bar({ targetTypeId: null, dock: PLAIN_DOCK });
    expect(await screen.findByTestId('top-nav-remote-control-panel')).toBeTruthy();
    expect(nav.replaceDock).toHaveBeenCalledTimes(1);
    expect(nav.replaceDock.mock.calls[0][0].cleared).toEqual(['remote-control', 'remote-control-assertion']);
    expect(nav.setOption).not.toHaveBeenCalled();
    expect(rc.confirm).not.toHaveBeenCalled();

    // The option is gone from the address; closing the panel leaves it closed.
    nav.current = { remoteControlOpen: false };
    await userEvent.keyboard('{Escape}');
    view.rerender(
      <TooltipProvider>
        <TopBarActions targetTypeId={null} targetTitle="Doc" dock={PLAIN_DOCK} />
      </TooltipProvider>,
    );
    expect(screen.queryByTestId('top-nav-remote-control-panel')).toBeNull();
    expect(nav.replaceDock).toHaveBeenCalledTimes(1);
  });

  it('a dock carrying the fingerprint answer hands it to the machine once, clears both options, then opens the panel', async () => {
    nav.current = { remoteControlOpen: true, remoteControlAssertion: 'ZW5jb2RlZA' };
    const view = bar({ targetTypeId: null, dock: PLAIN_DOCK });
    expect(await screen.findByTestId('top-nav-remote-control-panel')).toBeTruthy();
    expect(rc.confirm).toHaveBeenCalledTimes(1);
    expect(rc.confirm).toHaveBeenCalledWith('ZW5jb2RlZA');
    expect(nav.replaceDock).toHaveBeenCalledTimes(1);
    expect(nav.replaceDock.mock.calls[0][0].cleared).toEqual(['remote-control', 'remote-control-assertion']);

    // A render that still sees the old address does not hand it in again.
    view.rerender(
      <TooltipProvider>
        <TopBarActions targetTypeId={null} targetTitle="Doc" dock={PLAIN_DOCK} />
      </TooltipProvider>,
    );
    expect(rc.confirm).toHaveBeenCalledTimes(1);
  });

  it('while on, the glowing icon is in the bar, says the time left, and opens the panel', async () => {
    bar({ targetTypeId: null, dock: PLAIN_DOCK });
    expect(screen.queryByTestId('top-nav-remote-control')).toBeNull();
    cleanup();

    rc.status = { available: true, on: true, open_until: '2026-11-21T11:00:00Z' };
    bar({ targetTypeId: null, dock: PLAIN_DOCK });
    const icon = screen.getByTestId('top-nav-remote-control');
    await userEvent.hover(icon);
    const tips = await screen.findAllByTestId('top-nav-remote-control-tooltip');
    expect(tips[0].textContent).toContain('Remote control is on · 2026-11-21T11:00:00Z');
    await userEvent.click(icon);
    expect(await screen.findByTestId('top-nav-remote-control-panel')).toBeTruthy();
  });
});

/**
 * `WizardViewer` — the two behaviours a person actually depends on.
 *
 * 1. The approval gate is rendered IN THE PAGE, never `window.confirm`. A native
 *    modal blocks the whole renderer (nothing else paints, and any automation
 *    driving the app deadlocks on it) and cannot show what is about to run,
 *    which is the entire point of the gate. This test asserts `window.confirm`
 *    is never called — that is the regression, not the wording.
 * 2. The last run is read from `run_state.result` — a `WizardResult` whose
 *    steps are each step's own answer. There is no parked state and no answer
 *    form: a wizard asks a person through an `ask` op, like any other step.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExitCode } from '@sdk';

import { TooltipProvider } from '@src/components/ui/tooltip';

const h = vi.hoisted(() => ({ callAction: vi.fn(), refreshByTypeId: vi.fn(), start: vi.fn() }));

/** The form lists installed agents and looks up trigger rows. Neither is what
 *  these tests are about, and both would otherwise reach for a backend. */
vi.mock('@src/hooks/entity-hooks', () => ({
  useEntitiesQuery: () => ({ data: [], isLoading: false, error: null }),
  useEntity: () => ({ data: null, isLoading: false, error: null }),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dataManager: { callAction: h.callAction, refreshByTypeId: h.refreshByTypeId },
  };
});
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));

/** The advanced gate reads the DOCK URL (view mode is URL-first), so rendering
 *  the real one would need a Router around every case here. The gate itself is
 *  covered by its own tests; what these assert is what sits behind it. */
const view = vi.hoisted(() => ({ advanced: false }));
vi.mock('@src/components/view-mode', () => ({
  AdvancedOnly: ({ children }: { children: React.ReactNode }) => (view.advanced ? <>{children}</> : null),
  useIsAdvanced: () => view.advanced,
}));

/** Side windows are dock state (`?sideWindows=…`), so the real hook needs a
 *  Router around every case here. The URL plumbing has its own tests; what
 *  these assert is which surface the viewer puts where. */
const side = vi.hoisted(() => ({
  windows: [] as string[],
  open: vi.fn(),
  close: vi.fn(),
  closeAll: vi.fn(),
  select: vi.fn(),
  toggle: vi.fn(),
}));
/** The trigger section links into the Events dock, so the form now reads dock
 *  navigation — which is URL-first and needs a Router the unit tier has not
 *  got. The link target has its own test. */
const nav = vi.hoisted(() => ({ openDock: vi.fn(), goHome: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: nav, currentDock: null }),
}));

vi.mock('@src/navigation/useSideWindows', () => ({
  useSideWindows: () => ({ ...side, active: side.windows[side.windows.length - 1] ?? null }),
}));

/** The real animation reads layout (`getBoundingClientRect`) and drives the
 *  DOM directly — nothing a jsdom render needs, and not what these tests are
 *  about. What matters here is only that minimizing CALLS it, on the dialog's
 *  own content node. */
const minimize = vi.hoisted(() => ({ toProcessChip: vi.fn() }));
vi.mock('@src/lib/minimize-to-element', () => ({
  animateMinimizeToProcessChip: minimize.toProcessChip,
}));

import { WizardViewer } from '@src/components/assets/editor/wizard/WizardViewer';

const wizard = (runState: Record<string, unknown>, shipped = false) =>
  ({
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'UI probe',
    description: 'Asks for a name.',
    shipped,
    run_state: runState,
    activity_path: 'wizard-ui-probe',
    typeId: { toString: () => 'wizard-550e8400-e29b-41d4-a716-446655440000' },
    validateDocument: () => Promise.resolve({ ok: true, issues: [] }),
    runDetail: () => Promise.resolve({ result: runState.result ?? null }),
    resetRun: () => Promise.resolve({}),
    start: h.start,
  }) as never;

/** The wizard FOLDER. The viewer names `wizard.json` beneath it itself — the
 *  same move as McpViewer — so these tests hand it the folder, not the file.
 *  Each case differs only in how the read resolves, so that is the parameter. */
const refWith = (read: () => Promise<string>) =>
  ({
    path: '/w/agentic-assets/wizard/ui-probe',
    child: () => ({
      path: '/w/agentic-assets/wizard/ui-probe/wizard.json',
      read,
      write: () => Promise.resolve(undefined),
    }),
  }) as never;

const DOC = JSON.stringify({ name: 'UI probe', steps: [] });
const fsRef = () => refWith(() => Promise.resolve(DOC));

/** A step's own detail is a Tooltip now, and `Tooltip.Root` throws without a
 *  `TooltipProvider` ancestor — in the app that is mounted once in `App.tsx`,
 *  which nothing here renders. `delayDuration={0}` so a hover in a test does
 *  not need a real wait to open. */
const renderWizard = (ui: React.ReactElement) => render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);

beforeEach(() => {
  view.advanced = false;
  side.windows = [];
  vi.clearAllMocks();
  h.callAction.mockResolvedValue({ exit_code: 0, steps: {} });
  h.refreshByTypeId.mockResolvedValue(null);
  h.start.mockResolvedValue({});
});
afterEach(cleanup);

describe('WizardViewer', () => {
  it('asks for approval in the page — never through window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={wizard({})} />);

    fireEvent.click(screen.getByTestId('wizard-run'));

    await screen.findByTestId('wizard-approval');
    expect(confirmSpy).not.toHaveBeenCalled();
    // Merely opening the panel must not have run anything yet.
    expect(h.callAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('wizard-approve'));
    await waitFor(() => expect(h.callAction).toHaveBeenCalledTimes(1));
    expect(h.callAction.mock.calls[0][0].bodyParameters).toEqual({ approved: true });
  });

  it('runs a shipped wizard with no approval panel at all', async () => {
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={wizard({}, true)} />);
    fireEvent.click(screen.getByTestId('wizard-run'));
    await waitFor(() => expect(h.callAction).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('wizard-approval')).toBeNull();
    expect(h.callAction.mock.calls[0][0].bodyParameters).toEqual({});
  });
});

describe('a settled run', () => {
  const settled = {
    result: {
      exit_code: 1,
      detail: 'version: the cli call ran, but the check still fails.',
      steps: {
        version: { exit_code: 0, ran: false, detail: 'already satisfied' },
        build: { exit_code: 1, ran: true, detail: 'the check still fails' },
      },
    },
  };
  const DOC_TWO = JSON.stringify({
    name: 'UI probe',
    steps: [
      { id: 'version', kind: 'compute', ref: 'a', args: {} },
      { id: 'build', kind: 'compute', ref: 'b', args: {} },
      { id: 'deploy', kind: 'compute', ref: 'c', args: {} },
    ],
  });
  const fsRefTwo = () => refWith(() => Promise.resolve(DOC_TWO));

  it('does not repeat the run′s own detail at the bottom — each step already has it, on hover', () => {
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={wizard(settled)} />);
    expect(screen.queryByText(settled.result.detail)).toBeNull();
  });

  it('says nothing inline — a failed row′s own answer is read via "View error", not printed permanently', async () => {
    renderWizard(<WizardViewer fsRef={fsRefTwo()} wizard={wizard(settled)} />);
    await waitFor(() => expect(screen.getByTestId('wizard-step-build')).toBeTruthy());

    // A failed row's own detail is behind "View error" now, not always-visible
    // text: a slow, all-passing wizard used to print every step's own
    // "already satisfied" line permanently, drowning the one row that
    // actually needed reading — a failure — among five that did not.
    expect(screen.getByTestId('wizard-step-version').textContent).not.toContain('already satisfied');
    expect(screen.getByTestId('wizard-step-build').textContent).not.toContain('the check still fails');
    // A step no run reached has no answer, so it offers no "View error".
    expect(screen.queryByTestId('wizard-step-deploy-view-error')).toBeNull();
  });

  it('never offers "View error" for a satisfied step — there is nothing wrong to read', () => {
    renderWizard(<WizardViewer fsRef={fsRefTwo()} wizard={wizard(settled)} />);
    expect(screen.queryByTestId('wizard-step-version-view-error')).toBeNull();
  });

  it('shows a failed step′s own answer behind "View error"', async () => {
    const user = userEvent.setup();
    renderWizard(<WizardViewer fsRef={fsRefTwo()} wizard={wizard(settled)} />);
    await waitFor(() => expect(screen.getByTestId('wizard-step-build')).toBeTruthy());

    await user.hover(screen.getByTestId('wizard-step-build-view-error'));
    expect((await screen.findByTestId('wizard-step-build-detail')).textContent).toContain('the check still fails');
  });

  it('copies a failed step\u2032s error text to the clipboard from the icon beside "View error"', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWizard(<WizardViewer fsRef={fsRefTwo()} wizard={wizard(settled)} />);
    await waitFor(() => expect(screen.getByTestId('wizard-step-build')).toBeTruthy());

    fireEvent.click(screen.getByTestId('wizard-step-build-copy-error'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('the check still fails')));
    // A step with nothing wrong has nothing to copy.
    expect(screen.queryByTestId('wizard-step-version-copy-error')).toBeNull();
  });

  it('reads a declined install question as the person′s decision — a red cross and "Cancelled by user", never an error', async () => {
    const declined = {
      result: {
        exit_code: 1,
        detail: 'Install X?: cancelled.',
        steps: {
          version: { exit_code: 0, ran: false, detail: 'already satisfied' },
          build: {
            exit_code: 1,
            ran: true,
            detail: 'Install X?: cancelled.',
            steps: { ask: { exit_code: 1, cancelled: true, detail: 'Install X?: cancelled.' } },
          },
        },
      },
    };
    renderWizard(<WizardViewer fsRef={fsRefTwo()} wizard={wizard(declined)} />);
    await waitFor(() => expect(screen.getByTestId('wizard-step-build')).toBeTruthy());

    expect(screen.getByTestId('wizard-step-build-declined').textContent).toContain('Cancelled by user');
    expect(screen.getByTestId('wizard-step-build').getAttribute('data-status')).toBe('declined');
    // Not a failure: nothing to view, nothing to copy.
    expect(screen.queryByTestId('wizard-step-build-view-error')).toBeNull();
    expect(screen.queryByTestId('wizard-step-build-copy-error')).toBeNull();
  });

  it('trims a row\u2032s text with an ellipsis, and keeps "View error" pinned beside it', async () => {
    renderWizard(<WizardViewer fsRef={fsRefTwo()} wizard={wizard(settled)} />);
    await waitFor(() => expect(screen.getByTestId('wizard-step-build')).toBeTruthy());
    expect(screen.getByTestId('wizard-step-build-summary').className).toContain('truncate');
    expect(screen.getByTestId('wizard-step-build-view-error').parentElement?.className).toContain('shrink-0');
  });

  it('never offers an answer form — a person is asked by an ask op, not by the viewer', () => {
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={wizard(settled)} />);
    expect(screen.queryByTestId('wizard-awaiting')).toBeNull();
    expect(screen.queryByTestId('wizard-answers')).toBeNull();
    // Run is always Run; there is no parked run to Continue.
    expect(screen.getByTestId('wizard-run').textContent).toContain('Run');
  });
});

describe('a fully finished run', () => {
  const finished = { result: { exit_code: ExitCode.OK, detail: '', ran: true, steps: {} } };

  it('says everything succeeded, and offers to go home', () => {
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={wizard(finished)} />);
    expect(screen.getByTestId('wizard-finished')).toBeTruthy();
    expect(screen.getByTestId('wizard-go-home')).toBeTruthy();
  });

  it('sends "Go to homepage" straight to the app home, same as the real Home button', () => {
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={wizard(finished)} />);
    fireEvent.click(screen.getByTestId('wizard-go-home'));
    expect(nav.goHome).toHaveBeenCalledWith({ homePage: true });
  });

  it('says nothing about being finished while the run is still going, or has not run at all', () => {
    const stillGoing = { result: { exit_code: ExitCode.NOT_YET, detail: 'still running', ran: false, steps: {} } };
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={wizard(stillGoing)} />);
    expect(screen.queryByTestId('wizard-finished')).toBeNull();
    cleanup();
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={wizard({})} />);
    expect(screen.queryByTestId('wizard-finished')).toBeNull();
  });
});

describe('a popup wizard', () => {
  const popupWizard = () => ({ ...wizard({}), popup: true, label: 'Finish setting up Flowpad' }) as never;

  it('a run that fell short says so, and offers Restart setup beside a plain Go to homepage', async () => {
    const short = {
      result: { exit_code: ExitCode.NOT_YET, detail: 'Claude Code: cancelled.', ran: true, steps: {} },
    };
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={{ ...wizard(short), popup: true } as never} />);
    expect(screen.getByTestId('wizard-not-finished').textContent).toContain("didn't finish");
    expect(screen.queryByTestId('wizard-finished')).toBeNull();

    fireEvent.click(screen.getByTestId('wizard-go-home'));
    expect(nav.goHome).toHaveBeenCalledWith({ homePage: true });

    fireEvent.click(screen.getByTestId('wizard-restart'));
    await waitFor(() => expect(h.start).toHaveBeenCalledTimes(1));
  });

  it('a clean run shows the success message and no Restart', () => {
    const ok = { result: { exit_code: ExitCode.OK, detail: '', ran: true, steps: {} } };
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={{ ...wizard(ok), popup: true } as never} />);
    expect(screen.getByTestId('wizard-finished')).toBeTruthy();
    expect(screen.queryByTestId('wizard-restart')).toBeNull();
    expect(screen.queryByTestId('wizard-not-finished')).toBeNull();
  });

  it('shows the ordinary page, not a popup, when the document does not ask for one', () => {
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={wizard({})} />);
    expect(screen.queryByTestId('wizard-popup')).toBeNull();
    expect(screen.getByTestId('wizard-viewer-shell')).toBeTruthy();
  });

  it('shows as a dialog, with the document′s own label as its title, when it does', () => {
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={popupWizard()} />);
    expect(screen.getByTestId('wizard-popup')).toBeTruthy();
    // Twice on purpose: the visible `<h2>` and Radix's own required (sr-only)
    // accessible name for the dialog.
    expect(screen.getAllByText('Finish setting up Flowpad')).toHaveLength(2);
    // The full-page shell (side-drawer machinery) is not what a popup renders.
    expect(screen.queryByTestId('wizard-viewer-shell')).toBeNull();
  });

  it('minimizing flies the dialog into the footer chip and leaves — nothing to pause, the run is server-side', () => {
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={popupWizard()} />);
    fireEvent.click(screen.getByTestId('wizard-minimize'));
    expect(minimize.toProcessChip).toHaveBeenCalledTimes(1);
    expect(nav.goHome).toHaveBeenCalledWith({ homePage: true });
  });

  it('offers no Run/Reset — a popup wizard has Start instead', () => {
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={popupWizard()} />);
    expect(screen.queryByTestId('wizard-run')).toBeNull();
    expect(screen.queryByTestId('wizard-reset')).toBeNull();
    expect(screen.getByTestId('wizard-start')).toBeTruthy();
  });

  it('Start calls the wizard′s own `start` action, which the backend waits for, then gets out of the way', async () => {
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={popupWizard()} />);
    fireEvent.click(screen.getByTestId('wizard-start'));
    expect(h.start).toHaveBeenCalledTimes(1);
    // Nothing left for it to do once the call is accepted — the run's own
    // live state takes over, the same way it does for any other run.
    await waitFor(() => expect(screen.queryByTestId('wizard-start')).toBeNull());
  });

  it('offers no Start once a run already exists — nothing left to wait for', () => {
    const started = { ...popupWizard(), run_state: { result: { exit_code: ExitCode.NOT_YET, steps: {} } } } as never;
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={started} />);
    expect(screen.queryByTestId('wizard-start')).toBeNull();
  });
});

describe('the advanced gate is a skin', () => {
  /** Counts reads, so "the hooks still ran" is observable rather than asserted
   *  about internals. */
  const countingRef = (reads: { n: number }) =>
    refWith(() => {
      reads.n += 1;
      return Promise.resolve(
        JSON.stringify({ name: 'UI probe', steps: [{ id: 'a', kind: 'compute', ref: 'noop', args: {} }] }),
      );
    });

  it('hides the editor and debugger in Standard, without skipping the work', async () => {
    const reads = { n: 0 };
    view.advanced = false;
    renderWizard(<WizardViewer fsRef={countingRef(reads)} wizard={wizard({})} />);

    expect(screen.queryByTestId('wizard-form')).toBeNull();
    expect(screen.queryByTestId('wizard-debugger')).toBeNull();
    // The gate changes rendering ONLY. If it changed which hooks ran, the panel
    // would arrive empty on the first frame after switching to Advanced.
    await waitFor(() => expect(reads.n).toBe(1));
  });

  it('shows the editor inline and OFFERS run detail in Advanced', async () => {
    view.advanced = true;
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={wizard({})} />);

    await waitFor(() => expect(screen.getByTestId('wizard-form')).toBeTruthy());
    // Run detail is a side window: the rail offers it, and it is not mounted
    // until someone opens it.
    expect(screen.getByTestId('wizard-side-tab-collapsed-wizard-run')).toBeTruthy();
    expect(screen.queryByTestId('wizard-debugger')).toBeNull();
  });

  it('renders run detail in the side drawer once that window is open', async () => {
    view.advanced = true;
    side.windows = ['wizard-run'];
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={wizard({})} />);

    await waitFor(() => expect(screen.getByTestId('wizard-side-window')).toBeTruthy());
    expect(screen.getByTestId('wizard-debugger')).toBeTruthy();
  });

  it('offers no run-detail window in Standard', () => {
    view.advanced = false;
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={wizard({})} />);

    expect(screen.queryByTestId('wizard-side-tab-collapsed-wizard-run')).toBeNull();
    expect(screen.queryByTestId('wizard-debugger')).toBeNull();
  });

  it('puts Reset beside Run, and only in Advanced', () => {
    view.advanced = false;
    const { unmount } = renderWizard(<WizardViewer fsRef={fsRef()} wizard={wizard({})} />);
    expect(screen.queryByTestId('wizard-reset')).toBeNull();
    unmount();

    view.advanced = true;
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={wizard({})} />);
    const header = screen.getByTestId('wizard-run').closest('header');
    // Same header as Run: they are one decision made twice — start it, or
    // start it over.
    expect(header?.contains(screen.getByTestId('wizard-reset'))).toBe(true);
  });

  it('offers no editor for a conversational wizard — it has no steps to edit', () => {
    view.advanced = true;
    const conversational = { ...(wizard({}) as Record<string, unknown>), agent: 'git-setup' } as never;
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={conversational} />);

    expect(screen.queryByTestId('wizard-form')).toBeNull();
    expect(screen.queryByTestId('wizard-debugger')).toBeNull();
  });
});

describe('the document arrives asynchronously', () => {
  /** The read resolves on a later tick — as a real file read always does. The
   *  editor seeds its draft from it ONCE, so if nothing adopts it when it lands,
   *  the draft stays null for the life of the mount: the form still renders (it
   *  falls back to the loaded doc) while the step list and debugger are empty
   *  and every edit is a silent no-op. This is that regression. */
  const lateRef = () =>
    refWith(async () => {
      await new Promise((r) => setTimeout(r, 0));
      return JSON.stringify({
        name: 'UI probe',
        steps: [{ id: 'alpha', kind: 'compute', ref: 'noop', args: {} }],
      });
    });

  it('shows the steps from the document once the read lands', async () => {
    view.advanced = true;
    side.windows = ['wizard-run'];
    renderWizard(<WizardViewer fsRef={lateRef()} wizard={wizard({})} />);

    // The step list is sourced from the DOCUMENT, so a wizard that has never
    // run still lists what it would do.
    await waitFor(() => expect(screen.getByTestId('wizard-step-alpha')).toBeTruthy());
    expect(screen.getByTestId('wizard-step-form-alpha')).toBeTruthy();
    // The side window reads the same joined steps.
    expect(screen.getByTestId('wizard-inspect-alpha')).toBeTruthy();
  });
});

describe('starting a run reveals what it is doing', () => {
  it('opens the run-detail window when Run is clicked', async () => {
    view.advanced = true;
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={wizard({ approved: true })} />);

    fireEvent.click(screen.getByTestId('wizard-run'));

    // A navigation, not a local toggle: the drawer renders from the URL.
    await waitFor(() => expect(side.open).toHaveBeenCalledWith('wizard-run'));
  });

  it('opens it on the approval path too', async () => {
    view.advanced = true;
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={wizard({})} />);

    fireEvent.click(screen.getByTestId('wizard-run'));
    fireEvent.click(await screen.findByTestId('wizard-approve'));

    await waitFor(() => expect(side.open).toHaveBeenCalledWith('wizard-run'));
  });

  it('does not push again when the window is already open', async () => {
    view.advanced = true;
    side.windows = ['wizard-run'];
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={wizard({ approved: true })} />);

    fireEvent.click(screen.getByTestId('wizard-run'));

    // `open` pushes unconditionally, so re-running with the panel already up
    // would add a history entry per click for a URL that never changed.
    await waitFor(() => expect(h.callAction).toHaveBeenCalled());
    expect(side.open).not.toHaveBeenCalled();
  });

  it('stamps no side-window id in Standard, where nothing renders it', async () => {
    view.advanced = false;
    renderWizard(<WizardViewer fsRef={fsRef()} wizard={wizard({ approved: true })} />);

    fireEvent.click(screen.getByTestId('wizard-run'));

    await waitFor(() => expect(h.callAction).toHaveBeenCalled());
    expect(side.open).not.toHaveBeenCalled();
  });
});

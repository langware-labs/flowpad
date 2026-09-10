/**
 * `WizardViewer` — the two behaviours a person actually depends on.
 *
 * 1. The approval gate is rendered IN THE PAGE, never `window.confirm`. A native
 *    modal blocks the whole renderer (nothing else paints, and any automation
 *    driving the app deadlocks on it) and cannot show what is about to run,
 *    which is the entire point of the gate. This test asserts `window.confirm`
 *    is never called — that is the regression, not the wording.
 * 2. A parked run renders its form FROM `awaiting[]`, so a wizard that declares
 *    a new input grows a field with no change to this component.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ callAction: vi.fn(), refreshByTypeId: vi.fn() }));

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
  AdvancedOnly: ({ children }: { children: React.ReactNode }) =>
    view.advanced ? <>{children}</> : null,
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
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));

vi.mock('@src/navigation/useSideWindows', () => ({
  useSideWindows: () => ({ ...side, active: side.windows[side.windows.length - 1] ?? null }),
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
    validateDocument: async () => ({ ok: true, issues: [] }),
    runDetail: async () => ({ outcomes: runState.outcomes ?? [] }),
    resetRun: async () => ({}),
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
      write: async () => undefined,
    }),
  }) as never;

const DOC = JSON.stringify({ name: 'UI probe', steps: [] });
const fsRef = () => refWith(async () => DOC);

beforeEach(() => {
  view.advanced = false;
  side.windows = [];
  vi.clearAllMocks();
  h.callAction.mockResolvedValue({ status: 'pending' });
  h.refreshByTypeId.mockResolvedValue(null);
});
afterEach(cleanup);

describe('WizardViewer', () => {
  it('asks for approval in the page — never through window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<WizardViewer fsRef={fsRef()} wizard={wizard({})} />);

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
    render(<WizardViewer fsRef={fsRef()} wizard={wizard({}, true)} />);
    fireEvent.click(screen.getByTestId('wizard-run'));
    await waitFor(() => expect(h.callAction).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('wizard-approval')).toBeNull();
    expect(h.callAction.mock.calls[0][0].bodyParameters).toEqual({});
  });

  it('renders the form from awaiting[] and submits the value by name', async () => {
    render(
      <WizardViewer fsRef={fsRef()} wizard={wizard({
          status: 'pending',
          awaiting: [{ name: 'marker', label: 'Marker file name', description: 'Under /tmp' }],
          outcomes: [{ step_id: 'ask', status: 'awaiting_input', message: 'needs marker' }],
        })}
      />,
    );

    expect(screen.getByText('Marker file name')).toBeTruthy();
    fireEvent.change(screen.getByTestId('wizard-input-marker'), {
      target: { value: 'proof.txt' },
    });
    fireEvent.click(screen.getByTestId('wizard-submit-marker'));

    await waitFor(() => expect(h.callAction).toHaveBeenCalledTimes(1));
    const info = h.callAction.mock.calls[0][0];
    expect(info.name ?? info.actionName).toBe('set-input');
    expect(info.bodyParameters).toEqual({ name: 'marker', value: 'proof.txt' });
  });
});

describe('a settled run', () => {
  const settled = {
    status: 'completed',
    inputs: { release: '0.2.136' },
    outcomes: [{ step_id: 'version', status: 'satisfied', message: 'provided' }],
  };

  it('shows what the last run was answered with', () => {
    render(<WizardViewer fsRef={fsRef()} wizard={wizard(settled)} />);
    expect(screen.getByTestId('wizard-answer-release').textContent).toContain('0.2.136');
  });

  it('shows nothing when the run was never given an answer', () => {
    render(<WizardViewer fsRef={fsRef()} wizard={wizard({ ...settled, inputs: {} })} />);
    expect(screen.queryByTestId('wizard-answers')).toBeNull();
  });
});

describe('re-asking', () => {
  const parked = {
    status: 'pending',
    inputs: { release: '0.2.136' },
    awaiting: [{ name: 'release', label: 'Release tag' }],
    outcomes: [{ step_id: 'version', status: 'awaiting_input' }],
  };

  it('offers the previous answer back in the field', () => {
    // A fresh run ASKS, but it should not pretend the wizard has never been
    // told anything — that would mean retyping an unchanged value every time.
    render(<WizardViewer fsRef={fsRef()} wizard={wizard(parked)} />);
    expect((screen.getByTestId('wizard-input-release') as HTMLInputElement).value).toBe('0.2.136');
  });

  it('accepts the offered value untouched', async () => {
    // Reading only local state would make Continue a no-op on a form that
    // already looks filled in.
    render(<WizardViewer fsRef={fsRef()} wizard={wizard(parked)} />);
    fireEvent.click(screen.getByTestId('wizard-submit-release'));

    await waitFor(() => expect(h.callAction).toHaveBeenCalledTimes(1));
    expect(h.callAction.mock.calls[0][0].bodyParameters).toEqual({
      name: 'release',
      value: '0.2.136',
    });
  });

  it('takes an edit over the offered value', async () => {
    render(<WizardViewer fsRef={fsRef()} wizard={wizard(parked)} />);
    fireEvent.change(screen.getByTestId('wizard-input-release'), {
      target: { value: 'v0.3.0-rc1' },
    });
    fireEvent.click(screen.getByTestId('wizard-submit-release'));

    await waitFor(() => expect(h.callAction).toHaveBeenCalledTimes(1));
    expect(h.callAction.mock.calls[0][0].bodyParameters.value).toBe('v0.3.0-rc1');
  });
});

describe('the advanced gate is a skin', () => {
  /** Counts reads, so "the hooks still ran" is observable rather than asserted
   *  about internals. */
  const countingRef = (reads: { n: number }) =>
    refWith(async () => {
      reads.n += 1;
      return JSON.stringify({ name: 'UI probe', steps: [{ id: 'a', command: { commands: {} } }] });
    });

  it('hides the editor and debugger in Standard, without skipping the work', async () => {
    const reads = { n: 0 };
    view.advanced = false;
    render(<WizardViewer fsRef={countingRef(reads)} wizard={wizard({})} />);

    expect(screen.queryByTestId('wizard-form')).toBeNull();
    expect(screen.queryByTestId('wizard-debugger')).toBeNull();
    // The gate changes rendering ONLY. If it changed which hooks ran, the panel
    // would arrive empty on the first frame after switching to Advanced.
    await waitFor(() => expect(reads.n).toBe(1));
  });

  it('shows the editor inline and OFFERS run detail in Advanced', async () => {
    view.advanced = true;
    render(<WizardViewer fsRef={fsRef()} wizard={wizard({})} />);

    await waitFor(() => expect(screen.getByTestId('wizard-form')).toBeTruthy());
    // Run detail is a side window: the rail offers it, and it is not mounted
    // until someone opens it.
    expect(screen.getByTestId('wizard-side-tab-collapsed-wizard-run')).toBeTruthy();
    expect(screen.queryByTestId('wizard-debugger')).toBeNull();
  });

  it('renders run detail in the side drawer once that window is open', async () => {
    view.advanced = true;
    side.windows = ['wizard-run'];
    render(<WizardViewer fsRef={fsRef()} wizard={wizard({})} />);

    await waitFor(() => expect(screen.getByTestId('wizard-side-window')).toBeTruthy());
    expect(screen.getByTestId('wizard-debugger')).toBeTruthy();
  });

  it('offers no run-detail window in Standard', () => {
    view.advanced = false;
    render(<WizardViewer fsRef={fsRef()} wizard={wizard({})} />);

    expect(screen.queryByTestId('wizard-side-tab-collapsed-wizard-run')).toBeNull();
    expect(screen.queryByTestId('wizard-debugger')).toBeNull();
  });

  it('puts Reset beside Run, and only in Advanced', async () => {
    view.advanced = false;
    const { unmount } = render(<WizardViewer fsRef={fsRef()} wizard={wizard({})} />);
    expect(screen.queryByTestId('wizard-reset')).toBeNull();
    unmount();

    view.advanced = true;
    render(<WizardViewer fsRef={fsRef()} wizard={wizard({})} />);
    const header = screen.getByTestId('wizard-run').closest('header');
    // Same header as Run: they are one decision made twice — start it, or
    // start it over.
    expect(header?.contains(screen.getByTestId('wizard-reset'))).toBe(true);
  });

  it('offers no editor for a conversational wizard — it has no steps to edit', () => {
    view.advanced = true;
    const conversational = { ...(wizard({}) as Record<string, unknown>), agent: 'git-setup' } as never;
    render(<WizardViewer fsRef={fsRef()} wizard={conversational} />);

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
        steps: [{ id: 'alpha', command: { commands: { darwin: 'true' } } }],
      });
    });

  it('shows the steps from the document once the read lands', async () => {
    view.advanced = true;
    side.windows = ['wizard-run'];
    render(<WizardViewer fsRef={lateRef()} wizard={wizard({})} />);

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
    render(<WizardViewer fsRef={fsRef()} wizard={wizard({ approved: true })} />);

    fireEvent.click(screen.getByTestId('wizard-run'));

    // A navigation, not a local toggle: the drawer renders from the URL.
    await waitFor(() => expect(side.open).toHaveBeenCalledWith('wizard-run'));
  });

  it('opens it on the approval path too', async () => {
    view.advanced = true;
    render(<WizardViewer fsRef={fsRef()} wizard={wizard({})} />);

    fireEvent.click(screen.getByTestId('wizard-run'));
    fireEvent.click(await screen.findByTestId('wizard-approve'));

    await waitFor(() => expect(side.open).toHaveBeenCalledWith('wizard-run'));
  });

  it('opens it when an answer resumes a parked run', async () => {
    view.advanced = true;
    render(
      <WizardViewer
        fsRef={fsRef()}
        wizard={wizard({
          status: 'pending',
          approved: true,
          awaiting: [{ name: 'marker' }],
          inputs: { marker: 'proof.txt' },
        })}
      />,
    );

    fireEvent.click(screen.getByTestId('wizard-submit-marker'));

    // `set-input` runs the wizard again, so it is a run start as well.
    await waitFor(() => expect(side.open).toHaveBeenCalledWith('wizard-run'));
  });

  it('does not push again when the window is already open', async () => {
    view.advanced = true;
    side.windows = ['wizard-run'];
    render(<WizardViewer fsRef={fsRef()} wizard={wizard({ approved: true })} />);

    fireEvent.click(screen.getByTestId('wizard-run'));

    // `open` pushes unconditionally, so re-running with the panel already up
    // would add a history entry per click for a URL that never changed.
    await waitFor(() => expect(h.callAction).toHaveBeenCalled());
    expect(side.open).not.toHaveBeenCalled();
  });

  it('stamps no side-window id in Standard, where nothing renders it', async () => {
    view.advanced = false;
    render(<WizardViewer fsRef={fsRef()} wizard={wizard({ approved: true })} />);

    fireEvent.click(screen.getByTestId('wizard-run'));

    await waitFor(() => expect(h.callAction).toHaveBeenCalled());
    expect(side.open).not.toHaveBeenCalled();
  });
});

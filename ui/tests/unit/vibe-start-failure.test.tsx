/**
 * The vibe chat's first prompt, when it cannot start.
 *
 * The backend explains this failure precisely — `createProcess` refuses a
 * missing harness with `"<name> is not installed on this machine."`
 * (`flow_sdk/builtin/faas/scan_actions.py`). The catch here replaced that with
 * a fixed `Failed to start the build session.`, so the one sentence the reader
 * could act on reached the browser console and nowhere else. A person typing
 * into the chat saw the word "error" and had nothing to do next.
 *
 * Two behaviours, and the split between them is the point:
 *  - a MISSING HARNESS is not a message problem, it is a thing to fix, so it
 *    raises the install dialog carrying "Try auto install";
 *  - anything else keeps its own real message instead of a generic one.
 *
 * Which of the two is decided by a re-probe, never by the capability row the
 * failed call already consulted — that row is what let the launch through.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { PROJECT, ...h } = vi.hoisted(() => ({
  PROJECT: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01',
  launch: vi.fn(),
  test: vi.fn(),
  getSnapshot: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock('@src/notifications', () => ({ notify: { error: h.notifyError, success: vi.fn() } }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openNewShell: vi.fn(), openDock: vi.fn() }, currentDock: null }),
}));
vi.mock('@sdk/react/hooks', () => ({
  // A real v4 id: `chatTargetForProject` builds a TypeId and rejects anything else.
  useProject: () => ({ project: { id: PROJECT, fs_storage_mount_path: '/w', name: 'p' } }),
  useCapability: () => ({ capability: null, available: false, result: null, isLoading: false, test: vi.fn() }),
}));
// Mocked at the REAL boundary the launch crosses. Stubbing the module under
// test does not work: the hook calls `launchVibeSessionForProject` directly by
// its module-scope binding, which a module mock never reaches.
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    capabilityManager: { test: h.test, getSnapshot: h.getSnapshot },
    ComputeNode: { ...actual.ComputeNode, getById: () => Promise.resolve({ createProcess: h.launch }) },
  };
});

import { CapabilityKinds } from '@sdk';
import { useStartVibeSession } from '@src/pages/flow-page/use-start-vibe-session';

/** Mount the hook, render its dialog, and hand back the submit callback.
 *  The dialog is queried through `screen`, not the container: Radix portals it
 *  to document.body, so a container-scoped query never sees it. `cleanup()`
 *  between tests is what keeps that honest. */
function mountVibe() {
  let submit!: (m: string) => void;
  function Probe() {
    const { start, installDialog } = useStartVibeSession();
    submit = start;
    return <>{installDialog}</>;
  }
  render(<Probe />);
  return {
    submit: (m = 'build me a thing') => submit(m),
    dialog: () => screen.queryByTestId('install-one-of-dialog'),
  };
}

const CLAUDE = 'harness.claude.cli';

/** What the backend actually sends for a refused launch. */
function refusal(message: string) {
  return Object.assign(new Error('Request failed with status code 400'), {
    response: { status: 400, data: { message } },
  });
}

describe('vibe chat start failure', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    // The umbrella resolves to the default assistant — what a launch would use.
    h.getSnapshot.mockReturnValue({ resolvedKind: CLAUDE });
  });

  it('offers the install dialog when the harness really is missing', async () => {
    h.launch.mockRejectedValue(refusal('Claude CLI is not installed on this machine.'));
    h.test.mockResolvedValue({ available: false });

    const { submit, dialog } = mountVibe();
    submit();

    await waitFor(() => expect(h.test).toHaveBeenCalledWith(CLAUDE));
    await waitFor(() => expect(dialog()).toBeTruthy());
    // No toast: the dialog IS the response, and a generic error beside it would
    // just be noise.
    expect(h.notifyError).not.toHaveBeenCalled();
  });

  it("shows the backend's own sentence when the harness is present", async () => {
    // Not a missing harness — so the failure keeps its real explanation rather
    // than being flattened into "Failed to start the build session."
    h.launch.mockRejectedValue(refusal('Workspace is read-only.'));
    h.test.mockResolvedValue({ available: true });

    const { submit, dialog } = mountVibe();
    submit();

    await waitFor(() =>
      expect(h.notifyError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Workspace is read-only.' })),
    );
    expect(dialog()).toBeNull();
  });

  it('falls back to its own wording when the backend explained nothing', async () => {
    // A bare client-side failure carries no envelope. `errorMessage` must not
    // put axios's "Request failed with status code 500" in front of the user.
    h.launch.mockRejectedValue(new Error('Request failed with status code 500'));
    h.test.mockResolvedValue({ available: true });

    const { submit } = mountVibe();
    submit();

    await waitFor(() => expect(h.notifyError).toHaveBeenCalled());
    const { message } = h.notifyError.mock.calls[0][0] as { message: string };
    expect(message).not.toContain('status code');
  });

  it('probes the assistant the launch would use, not the umbrella', async () => {
    // The Windows report. `getSnapshot('harness').available` is a `.some()` over
    // every harness row, so a machine with Codex installed and Claude missing
    // answers "available" to the umbrella — and the dialog never appeared even
    // though the launch failed for the harness that IS missing. Asking about the
    // RESOLVED kind is what makes the answer about the right assistant.
    h.launch.mockRejectedValue(refusal('Claude CLI is not installed on this machine.'));
    h.getSnapshot.mockReturnValue({ resolvedKind: CLAUDE });
    h.test.mockResolvedValue({ available: false });

    const { submit, dialog } = mountVibe();
    submit();

    await waitFor(() => expect(h.test).toHaveBeenCalledWith(CLAUDE));
    expect(h.test).not.toHaveBeenCalledWith(CapabilityKinds.Harness);
    await waitFor(() => expect(dialog()).toBeTruthy());
  });
});

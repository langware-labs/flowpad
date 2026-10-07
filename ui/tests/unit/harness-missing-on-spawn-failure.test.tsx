/**
 * A spawn that fails because the harness is GONE must offer to install it —
 * not silently redirect to the Capabilities view and call the matter closed.
 *
 * The pre-flight in `startAgenticTab` reads the status record, and the record
 * goes stale: a harness uninstalled since the last discovery sweep still reads
 * `installed`, so the check passes and the spawn is the first thing to notice.
 * The old catch block ASSUMED that was the cause ("overwhelmingly...") and
 * navigated to Capabilities for every failure alike — so the one dialog that
 * offers "Try auto install" could never appear on the path that needs it most,
 * and an unrelated failure was mislabelled as an uninstalled harness.
 *
 * The lever is `capabilityManager.test`: unlike the pre-flight's cached record
 * it re-runs discovery, so it can both answer the question and correct the
 * row. These pin that the answer — not an assumption — picks the destination.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  openTab: vi.fn(),
  openNewChat: vi.fn(),
  record: null as unknown,
  test: vi.fn(),
  // The re-probe resolves the kind first, so a launch that failed for the
  // DEFAULT assistant is not answered by a sibling that happens to be present.
  getSnapshot: vi.fn(() => ({ resolvedKind: 'harness.claude.cli' })),
  openSources: vi.fn(),
}));

vi.mock('@src/components/llm-sources/llm-sources-pointer', () => ({
  openLlmSources: h.openSources,
  llmSourcesPointer: (w?: string) => w ?? '',
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openTab: h.openTab, openNewShell: vi.fn() }, currentDock: null }),
}));
vi.mock('@src/navigation/open-new-chat', () => ({ openNewChat: h.openNewChat }));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sdk')>()),
  capabilityManager: {
    test: h.test,
    getSnapshot: h.getSnapshot,
    // The dialog reads its install command from the summary, not the row.
    getCachedSummary: () => null,
  },
}));

// Boundaries the strip needs to mount but whose behaviour is not under test.
vi.mock('@sdk/react/hooks/useRuntimeInfo', () => ({ useRuntimeInfo: () => ({}) }));
vi.mock('@sdk/react/hooks', () => ({
  useContext: () => ({ sandboxComputeNode: null }),
  // The install dialog's own row probe — rendered here so the assertion can be
  // "the dialog is on screen", not merely "we did not redirect".
  useCapability: () => ({ capability: null, available: false, result: null, isLoading: false, test: vi.fn() }),
}));
vi.mock('@src/contexts/view-mode-context', () => ({
  useIsAdvanced: () => true,
  getEffectiveViewMode: () => 'advanced',
  previousNonVibeViewMode: () => 'advanced',
  ViewMode: { Advanced: 'advanced', Vibe: 'vibe' },
}));
// No status record read yet: install warnings fail open on that, so no opener carries a
// warning badge and nothing here pre-empts the path under test.
vi.mock('@src/components/workers/harness-availability', () => ({
  useHarnessAvailability: () => ({ warnings: {}, record: h.record }),
}));
vi.mock('@src/hooks/use-resume-in-terminal', () => ({ useResumeInTerminal: () => ({ resumeInTerminal: vi.fn() }) }));
vi.mock('@src/components/graph-view/icons/iconRegistry', () => ({ iconForType: () => () => null }));

import { CapabilityKinds } from '@sdk';
import { ViewType } from '@src/types/ViewType';
import { useTerminalStripController } from '@src/tabs/useTerminalStripController';

/** Mount the hook, rendering its modals, and hand back Start-Claude. */
function mountController(): () => Promise<void> | void {
  let handler!: () => Promise<void> | void;
  function Probe() {
    const controller = useTerminalStripController({});
    handler = controller.handleStartClaude;
    return <>{controller.modals}</>;
  }
  render(<Probe />);
  return handler;
}

describe('a spawn failure asks whether the harness is really gone', () => {
  beforeEach(() => {
    // The dialog is portaled to document.body, so a previous test's copy
    // outlives its container and `screen` would find THAT one.
    cleanup();
    vi.clearAllMocks();
    // The stale record that lets the pre-flight through: it says "installed", so
    // no dialog is shown up front and the spawn is what discovers the truth.
    h.record = ({
      default_harness: 'harness.claude.cli',
      harnesses: [{ kind: 'harness.claude.cli', worker_type: 'claude', install: 'installed' }],
    });
    h.openNewChat.mockRejectedValue(new Error('worker binary not found'));
  });

  it('offers the install dialog when the re-probe confirms the harness is gone', async () => {
    h.test.mockResolvedValue({ available: false });

    await mountController()();

    await waitFor(() => expect(h.test).toHaveBeenCalledWith('harness.claude.cli'));
    // The dialog itself, on screen — this is the affordance that carries "Try
    // auto install", and the whole point of the fix is that it can now be
    // reached from a failed spawn.
    await waitFor(() => expect(screen.getByTestId('install-one-of-dialog')).toBeTruthy());
    // And NOT the redirect that used to swallow this case.
    expect(h.openTab).not.toHaveBeenCalled();
  });

  it('asks to install before spawning when the record already says the harness is gone', async () => {
    // The pre-flight's own refusal: a harness the status record reports `not_installed` is never
    // spawned at all — the install dialog comes first, with no failed launch on the way.
    h.record = ({
      default_harness: 'harness.claude.cli',
      harnesses: [{ kind: 'harness.claude.cli', worker_type: 'claude', install: 'not_installed' }],
    });

    await mountController()();

    expect(await screen.findByTestId('install-one-of-dialog')).toBeTruthy();
    expect(h.openNewChat).not.toHaveBeenCalled();
  });

  it('keeps the Capabilities view when the harness is present and something else failed', async () => {
    // A present harness means the failure was NOT a missing binary. Showing the
    // install dialog here would tell the user to install what they already have.
    h.test.mockResolvedValue({ available: true });

    await mountController()();

    await waitFor(() =>
      expect(h.openTab).toHaveBeenCalledWith(ViewType.CAPABILITIES, { capabilityKind: CapabilityKinds.ClaudeCode }),
    );
  });

  it('falls back to the Capabilities view when the re-probe itself fails', async () => {
    // No answer is not the same as "it is missing" — an unanswerable probe must
    // not put words in the backend's mouth.
    h.test.mockRejectedValue(new Error('capability API unavailable'));

    await mountController()();

    await waitFor(() =>
      expect(h.openTab).toHaveBeenCalledWith(ViewType.CAPABILITIES, { capabilityKind: CapabilityKinds.ClaudeCode }),
    );
  });

  it('sends an unfunded harness to LLM sources instead of the Capabilities view', async () => {
    // Installed, resolved, and refused for want of funding. Capabilities is an
    // inventory of what is INSTALLED — it can only offer a re-check and an
    // installer for something the machine already has.
    h.openNewChat.mockRejectedValue(new Error('claude has no usable LLM source:\n  - claude device login: signed out'));

    await mountController()();

    await waitFor(() => expect(h.openSources).toHaveBeenCalled());
    expect(h.openTab).not.toHaveBeenCalled();
    expect(h.test).not.toHaveBeenCalled();
  });
});

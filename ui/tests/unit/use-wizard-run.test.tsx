/**
 * useWizardRun — the button orchestration:
 *   - single click runs the wizard HEADLESS and pops the result when it finishes;
 *   - double click opens the modal (launchWizard) instead;
 *   - an `adopt` payload reflects an already-running process (no new run).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// vi.mock factories are hoisted above module-scope consts, so the shared spies
// must be created via vi.hoisted to be referenceable inside them.
const h = vi.hoisted(() => ({
  startWizardProcess: vi.fn(),
  attachWizardModal: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  launchWizard: vi.fn(),
  awaitWizardResult: vi.fn(),
}));

vi.mock('@src/components/wizard/start-wizard-process', () => ({ startWizardProcess: h.startWizardProcess }));
vi.mock('@src/components/wizard/wizard-modal', () => ({ attachWizardModal: h.attachWizardModal }));
vi.mock('@src/notifications', () => ({ notify: { success: h.notifySuccess, error: h.notifyError } }));
vi.mock('@src/hooks/use-agentic-process-stream', () => ({ useAgenticProcessStream: () => [] }));
vi.mock('@sdk', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return { ...actual, launchWizard: h.launchWizard, awaitWizardResult: h.awaitWizardResult };
});

import { useWizardRun } from '@src/hooks/use-wizard-run';

const baseOpts = () => ({
  wizardName: 'task-analyze',
  buildRequest: () => Promise.resolve({ title: 'x' }),
  successMessage: 'Report ready',
  doubleClickMs: 5, // keep the click-disambiguation window tiny for the test
});

beforeEach(() => {
  vi.clearAllMocks();
  h.awaitWizardResult.mockReturnValue(new Promise(() => {})); // never resolves unless overridden
});

describe('useWizardRun', () => {
  it('single click runs headless, then pops the success message on completion', async () => {
    let resolveResult: (r: unknown) => void = () => {};
    h.startWizardProcess.mockResolvedValue({
      process: { id: 'p1' },
      target: 't',
      result: new Promise((res) => (resolveResult = res)),
    });

    const { result } = renderHook(() => useWizardRun(baseOpts()));
    act(() => result.current.onClick());

    await waitFor(() =>
      expect(h.startWizardProcess).toHaveBeenCalledWith(
        { wizardName: 'task-analyze', wizardData: { title: 'x' } },
        { headless: true },
      ),
    );
    await waitFor(() => expect(result.current.phase).toBe('running'));

    act(() => resolveResult({ status: 'done', data: null }));
    await waitFor(() => expect(h.notifySuccess).toHaveBeenCalledWith({ title: 'Report ready' }));
    await waitFor(() => expect(result.current.phase).toBe('idle'));
  });

  it('double click opens the modal (launchWizard) and does not start a headless run', async () => {
    h.launchWizard.mockResolvedValue({ status: 'done', data: null });
    const { result } = renderHook(() => useWizardRun(baseOpts()));
    act(() => {
      result.current.onClick();
      result.current.onClick(); // second click within the window → double
    });
    await waitFor(() => expect(h.launchWizard).toHaveBeenCalledWith('task-analyze', { title: 'x' }));
    expect(h.startWizardProcess).not.toHaveBeenCalled();
  });

  it('reflects an already-running adopted process without starting a new run', async () => {
    const { result } = renderHook(() =>
      useWizardRun({
        ...baseOpts(),
        adopt: { process: { id: 'p9' } as any, target: 't', request: { wizardName: 'task-analyze' } },
      }),
    );
    await waitFor(() => expect(result.current.phase).toBe('running'));
    expect(h.startWizardProcess).not.toHaveBeenCalled();
    expect(h.awaitWizardResult).toHaveBeenCalled();
  });
});

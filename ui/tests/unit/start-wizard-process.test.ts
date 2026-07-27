/**
 * startWizardProcess — how a wizard run resolves.
 *
 * The core fix: a HEADLESS run must not hang forever if the agent finishes its
 * turn without emitting `wizard.closed`. It resolves on the first of:
 *   - `wizard.closed` (preferred — carries the verdict),
 *   - a prompt error,
 *   - (headless only) the prompt turn ending.
 * A POPUP run deliberately omits the turn-end path — there the user closes it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Controllable process: we drive its prompt() promise + the wizard.closed event.
let resolvePrompt: () => void;
let rejectPrompt: (e: unknown) => void;
let resolveClosed: (r: unknown) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fakeProcess: any;

// Hoisted spies so the vi.mock factory (hoisted above module consts) can use them.
const h = vi.hoisted(() => ({ getById: vi.fn(), awaitWizardResult: vi.fn(), apiGet: vi.fn() }));

vi.mock('@sdk', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual, // keep ProcessKind + the real buildWizardPrompt
    ComputeNode: { getById: h.getById },
    awaitWizardResult: h.awaitWizardResult,
    apiClient: { get: h.apiGet },
  };
});

import { startWizardProcess } from '@src/components/wizard/start-wizard-process';

const req = { wizardName: 'task-analyze', wizardData: { prompt: 'go' } };
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  fakeProcess = {
    id: 'proc-1',
    target_typeid_str: 'wizard:task-analyze:1',
    loadEmbeddedAgent: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn(
      () =>
        new Promise<void>((res, rej) => {
          resolvePrompt = res;
          rejectPrompt = rej;
        }),
    ),
  };
  h.apiGet.mockResolvedValue([]); // no agent ref → skip embed
  h.getById.mockResolvedValue({ createProcess: vi.fn().mockResolvedValue(fakeProcess) });
  h.awaitWizardResult.mockReturnValue(
    new Promise((res) => {
      resolveClosed = res;
    }),
  );
});

describe('startWizardProcess', () => {
  it('headless: resolves {done,null} when the turn ends without a close (no hang)', async () => {
    const { result } = await startWizardProcess(req, { headless: true });
    resolvePrompt(); // agent's turn ended, but never closed the wizard
    await expect(result).resolves.toEqual({ status: 'done', data: null });
  });

  it('headless: prefers the wizard.closed verdict when the agent closes', async () => {
    const { result } = await startWizardProcess(req, { headless: true });
    resolveClosed({ status: 'done', data: { readyForDone: true } });
    await expect(result).resolves.toEqual({ status: 'done', data: { readyForDone: true } });
  });

  it('popup: a turn ending does NOT resolve — only the user close does', async () => {
    const { result } = await startWizardProcess(req); // headless defaults false
    resolvePrompt();
    await tick();
    const race = await Promise.race([result.then(() => 'resolved'), tick().then(() => 'pending')]);
    expect(race).toBe('pending');

    // The user closing the popup (wizard.closed) is what resolves it.
    resolveClosed({ status: 'done', data: null });
    await expect(result).resolves.toEqual({ status: 'done', data: null });
  });

  it('resolves an error result when the prompt fails', async () => {
    const { result } = await startWizardProcess(req, { headless: true });
    rejectPrompt(new Error('boom'));
    await expect(result).resolves.toEqual({ status: 'error', data: null, errorStr: 'boom' });
  });
});

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
const h = vi.hoisted(() => ({
  getById: vi.fn(),
  awaitWizardResult: vi.fn(),
  apiGet: vi.fn(),
  systemSubagentRef: vi.fn(),
}));

const AGENT_REF = '/sys/agentic-assets/agent/task-analyze';

vi.mock('@src/pages/flow-page/vibe-personas', () => ({
  systemSubagentRef: h.systemSubagentRef,
}));

vi.mock('@sdk', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual, // keep ProcessKind + the real buildWizardPrompt
    ComputeNode: { getById: h.getById },
    awaitWizardResult: h.awaitWizardResult,
    apiClient: { get: h.apiGet },
    // The resolver hydrates rows through dataManager; the row shape is all we need.
    dataManager: { updateEntityFromJson: (row: unknown) => row },
  };
});

import {
  clearWizardAgentRefCache,
  startWizardProcess,
} from '@src/components/wizard/start-wizard-process';

const req = { wizardName: 'task-analyze', wizardData: { prompt: 'go' } };
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  fakeProcess = {
    id: 'proc-1',
    target_typeid_str: 'wizard:task-analyze:1',
    loadEmbeddedSubagent: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn(
      () =>
        new Promise<void>((res, rej) => {
          resolvePrompt = res;
          rejectPrompt = rej;
        }),
    ),
  };
  // A real wizard row. This used to be `[]` — "no agent ref → skip embed" — which
  // is exactly the soft failure that shipped: a name matching nothing produced a
  // live process running the wizard prompt with NO agent embedded, so it answered
  // as a generic assistant and never closed the wizard. The resolver now throws,
  // so the happy path has to supply a match like the real backend does.
  clearWizardAgentRefCache();
  // TWO hops now, and the stub has to answer them separately: the wizard ASSET
  // names the agent that drives it, and only then is the agent looked up. The
  // wizard name and the agent name are deliberately DIFFERENT here — they were
  // the same string under the old one-hop assumption, which is precisely what
  // made the indirection untestable.
  routeApi({
    wizards: [{ name: 'task-analyze', agent: 'task-analyze-agent' }],
    agents: [{ name: 'task-analyze-agent', asset_ref: AGENT_REF }],
  });
  h.getById.mockResolvedValue({ createProcess: vi.fn().mockResolvedValue(fakeProcess) });
  h.awaitWizardResult.mockReturnValue(
    new Promise((res) => {
      resolveClosed = res;
    }),
  );
});

/** The two hops, stubbed at the seams the resolver actually uses: the wizard
 *  listing over `apiClient`, and `systemSubagentRef` for the agent — which is
 *  the shared resolver (it filters `scope === 'system'`, so a project sub-agent
 *  cannot shadow a shipped one) rather than a second listing fetch of our own. */
function routeApi({ wizards, agents }: { wizards: unknown[]; agents: { name: string; asset_ref: string }[] }) {
  h.apiGet.mockResolvedValue(wizards);
  h.systemSubagentRef.mockImplementation((name: string) =>
    Promise.resolve(agents.find((a) => a.name === name)?.asset_ref ?? null),
  );
}

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

describe('an unknown wizard name', () => {
  it('throws before spawning anything, rather than prompting an unprimed agent', async () => {
    clearWizardAgentRefCache();
    routeApi({ wizards: [], agents: [] }); // nothing matches the requested name
    const createProcess = vi.fn();
    h.getById.mockResolvedValue({ createProcess });

    await expect(startWizardProcess({ wizardName: 'nope' })).rejects.toThrow(
      /No wizard named "nope" is installed/,
    );
    expect(createProcess).not.toHaveBeenCalled();
  });

  it('a wizard naming an agent that does not exist is also unknown', async () => {
    // The half-resolved case the second hop introduces: the wizard document is
    // indexed and names its agent, but that agent is not installed. Embedding
    // nothing and prompting anyway is the exact soft failure the throw exists to
    // prevent, so this must be as fatal as an unknown wizard name.
    clearWizardAgentRefCache();
    routeApi({ wizards: [{ name: 'orphan', agent: 'gone' }], agents: [] });
    const createProcess = vi.fn();
    h.getById.mockResolvedValue({ createProcess });

    await expect(startWizardProcess({ wizardName: 'orphan' })).rejects.toThrow(
      /No wizard named "orphan" is installed/,
    );
    expect(createProcess).not.toHaveBeenCalled();
  });

  it('does not cache the miss, so a wizard indexed afterwards resolves', async () => {
    clearWizardAgentRefCache();
    routeApi({ wizards: [], agents: [] });
    h.getById.mockResolvedValue({ createProcess: vi.fn() });
    await expect(startWizardProcess({ wizardName: 'later' })).rejects.toThrow();

    routeApi({
      wizards: [{ name: 'later', agent: 'later-agent' }],
      agents: [{ name: 'later-agent', asset_ref: '/x/later' }],
    });
    h.getById.mockResolvedValue({ createProcess: vi.fn().mockResolvedValue(fakeProcess) });
    await expect(startWizardProcess({ wizardName: 'later' })).resolves.toBeTruthy();
    expect(fakeProcess.loadEmbeddedSubagent).toHaveBeenCalledWith('/x/later');
  });
});

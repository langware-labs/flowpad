/**
 * FLOWPAD-2180 — `prepareAgentSession` is the "session is set up, start" step
 * for every session opened as an agent: it embeds the vibe layer and only then
 * kicks the prompt queue, so the auto prompt `Agent.use` queued runs as turn 1
 * with the layer in place. Sending it must never make an opened session look
 * like a failed one.
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareAgentSession, useAgentLauncher } from '@src/components/agents/use-agent-launcher';

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  watch: vi.fn(),
  drainQueue: vi.fn(),
  drainById: vi.fn(),
  embed: vi.fn(),
  openShellProcess: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  class FakeAgenticProcess {
    static type = 'agentic_process';
    static getById = mocks.getById;
    id: string;
    constructor(init: { id: string }) {
      this.id = init.id;
    }
    drainQueue() {
      return mocks.drainById(this.id);
    }
  }
  return { ...actual, AgenticProcess: FakeAgenticProcess };
});
vi.mock('@src/pages/flow-page/use-start-vibe-session', () => ({ embedVibeSubagent: mocks.embed }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openShellProcess: mocks.openShellProcess } }),
}));
vi.mock('@src/notifications', () => ({ notify: { error: mocks.notifyError } }));

const PROCESS_ID = '00000000-0000-4000-8000-000000000002';

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.embed.mockResolvedValue(undefined);
  mocks.watch.mockResolvedValue(undefined);
  mocks.drainQueue.mockResolvedValue(undefined);
  mocks.drainById.mockResolvedValue(undefined);
  mocks.openShellProcess.mockResolvedValue(undefined);
  mocks.getById.mockResolvedValue({ id: PROCESS_ID, watch: mocks.watch, drainQueue: mocks.drainQueue });
});

describe('prepareAgentSession', () => {
  it('embeds the vibe layer, then kicks the queue once', async () => {
    const proc = await prepareAgentSession(PROCESS_ID);

    expect(proc).not.toBeNull();
    expect(mocks.embed).toHaveBeenCalledWith(proc, { asPersona: false });
    expect(mocks.drainQueue).toHaveBeenCalledTimes(1);
    expect(mocks.embed.mock.invocationCallOrder[0]).toBeLessThan(mocks.drainQueue.mock.invocationCallOrder[0]);
  });

  it('swallows a refused drain: the session is still returned', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.drainQueue.mockRejectedValue(new Error('409 remote refusal'));

    const proc = await prepareAgentSession(PROCESS_ID);

    expect(proc).not.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('still sends the queued prompt by id when the process is not readable yet', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.getById.mockResolvedValue(null);

    const proc = await prepareAgentSession(PROCESS_ID);

    expect(proc).toBeNull();
    expect(mocks.drainById).toHaveBeenCalledWith(PROCESS_ID);
  });
});

describe('useAgentLauncher', () => {
  it('opens the session with the auto prompt, starts it, then navigates — no error toast on a refused drain', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.drainQueue.mockRejectedValue(new Error('409 remote refusal'));
    const use = vi.fn().mockResolvedValue({ process_id: PROCESS_ID });
    const agent = { id: 'agent-a', displayName: 'Greeter', use } as never;
    const { result } = renderHook(() => useAgentLauncher());

    await result.current.launch(agent, 'proj-1');

    expect(use).toHaveBeenCalledWith('proj-1', true);
    expect(mocks.drainQueue).toHaveBeenCalledTimes(1);
    expect(mocks.openShellProcess).toHaveBeenCalledWith(PROCESS_ID, expect.anything());
    expect(mocks.notifyError).not.toHaveBeenCalled();
  });
});

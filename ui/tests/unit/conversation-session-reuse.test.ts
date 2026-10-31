/**
 * A conversation has ONE worker session. Launching from the header or from a
 * message sends the prompt to that session (and stamps the message on it)
 * instead of starting a new worker. A new one starts only when there is none,
 * the existing one failed, or a different worker type is asked for.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess, FlowMessage, ProcessKind, TypeId } from '@sdk';
import { useConversationSession } from '@src/components/conversation/useConversationSession';
import { sessionMessageIds } from '@src/hooks/conversation/useMessageAutomationSessions';

const openShellProcess = vi.fn();
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openShellProcess } }),
}));
vi.mock('@src/components/conversation/apply-project-choice', () => ({
  resolveWorkdir: async () => '/work/project',
}));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));

const PROC_ID = '550e8400-e29b-41d4-a716-446655440001';
const MSG_ID = '550e8400-e29b-41d4-a716-446655440002';

function existingProcess(over: Record<string, unknown> = {}) {
  return {
    id: PROC_ID,
    process_type: ProcessKind.Conversation,
    worker_type: 'claude_code',
    status: 'running',
    created_date: '2026-10-30T10:00:00Z',
    shareContextEntities: vi.fn(async () => []),
    promptOrEnqueue: vi.fn(async () => undefined),
    ...over,
  };
}

function conversation(linked: boolean, role?: 'session') {
  return {
    id: '550e8400-e29b-41d4-a716-446655440003',
    project_id: 'proj-1',
    title: 'Chat',
    contextOfType: () => (linked ? [new TypeId(AgenticProcess.type, PROC_ID)] : []),
    getContextEntryData: () => (role ? { role } : undefined),
    shareContextEntities: vi.fn(async () => []),
  } as never;
}

function render(conv: unknown) {
  return renderHook(() =>
    useConversationSession({ conversation: conv as never, buildPrompt: () => 'status prompt' }),
  );
}

describe('a conversation launch reuses its session', () => {
  let launchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    launchSpy = vi
      .spyOn(AgenticProcess, 'launch')
      .mockResolvedValue({ id: '550e8400-e29b-41d4-a716-446655440009' } as never);
  });

  it('sends a message launch to the existing session, stamps the message, opens it — no new worker', async () => {
    const proc = existingProcess();
    vi.spyOn(AgenticProcess, 'getByIdFromCache').mockReturnValue(proc as never);
    const { result } = render(conversation(true));
    await waitFor(() => expect(result.current.conversationProcess).not.toBeNull());

    await act(async () => result.current.launch('claude_code', () => 'about this message', MSG_ID));

    expect(launchSpy).not.toHaveBeenCalled();
    expect(proc.shareContextEntities).toHaveBeenCalledWith(new TypeId(FlowMessage.type, MSG_ID));
    expect(proc.promptOrEnqueue).toHaveBeenCalledWith('about this message');
    expect(openShellProcess).toHaveBeenCalledWith(PROC_ID);
  });

  it('starts a new worker when the conversation has none', async () => {
    const { result } = render(conversation(false));
    await act(async () => result.current.launch('claude_code'));
    expect(launchSpy).toHaveBeenCalledTimes(1);
  });

  it('starts a new worker when the existing one failed', async () => {
    vi.spyOn(AgenticProcess, 'getByIdFromCache').mockReturnValue(existingProcess({ status: 'failed' }) as never);
    const { result } = render(conversation(true));
    await waitFor(() => expect(result.current.conversationProcess).not.toBeNull());
    await act(async () => result.current.launch('claude_code'));
    expect(launchSpy).toHaveBeenCalledTimes(1);
  });

  it('starts a new worker when a different worker type is asked for', async () => {
    vi.spyOn(AgenticProcess, 'getByIdFromCache').mockReturnValue(existingProcess() as never);
    const { result } = render(conversation(true));
    await waitFor(() => expect(result.current.conversationProcess).not.toBeNull());
    await act(async () => result.current.launch('codex'));
    expect(launchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('a session that wrote into the conversation is its session', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a chat session marked by the link is reused — not spawned again', async () => {
    const spy = vi.spyOn(AgenticProcess, 'launch');
    const proc = existingProcess({ process_type: ProcessKind.Chat });
    vi.spyOn(AgenticProcess, 'getByIdFromCache').mockReturnValue(proc as never);
    const { result } = render(conversation(true, 'session'));
    await waitFor(() => expect(result.current.conversationProcess?.id).toBe(PROC_ID));
    await act(async () => result.current.launch('claude_code'));
    expect(spy).not.toHaveBeenCalled();
    expect(proc.promptOrEnqueue).toHaveBeenCalledWith('status prompt');
  });

  it('a chat session linked without the mark (a shared transcript) is not the conversation\'s session', async () => {
    vi.spyOn(AgenticProcess, 'getByIdFromCache').mockReturnValue(existingProcess({ process_type: ProcessKind.Chat }) as never);
    const { result } = render(conversation(true));
    await waitFor(() => expect(AgenticProcess.getByIdFromCache).toHaveBeenCalled());
    expect(result.current.conversationProcess).toBeNull();
  });

  it('a UI launch marks the new session on the conversation', async () => {
    vi.spyOn(AgenticProcess, 'launch').mockResolvedValue({ id: PROC_ID } as never);
    const conv = conversation(false) as unknown as { shareContextEntities: ReturnType<typeof vi.fn> };
    const { result } = render(conv);
    await act(async () => result.current.launch('claude_code'));
    expect(conv.shareContextEntities).toHaveBeenCalledWith(new TypeId(AgenticProcess.type, PROC_ID), {
      data: { role: 'session' },
    });
  });
});

describe('a reused session shows on every message it was started from', () => {
  it('reads every message stamp, not just the first', () => {
    const a = new TypeId(FlowMessage.type, MSG_ID);
    const b = new TypeId(FlowMessage.type, '550e8400-e29b-41d4-a716-446655440004');
    const conv = new TypeId('conversation', '550e8400-e29b-41d4-a716-446655440003');
    const proc = { sharedContextEntities: [conv, a, b] } as unknown as AgenticProcess;
    expect(sessionMessageIds(proc)).toEqual([String(a.id), String(b.id)]);
  });
});

describe('every launch keys the session to the conversation', () => {
  it('a header launch sets target, so a later message reuse still shows its chip', async () => {
    vi.clearAllMocks();
    const spy = vi.spyOn(AgenticProcess, 'launch').mockResolvedValue({ id: '550e8400-e29b-41d4-a716-446655440009' } as never);
    const { result } = render(conversation(false));
    await act(async () => result.current.launch('claude_code'));
    expect(spy.mock.calls[0][0]).toMatchObject({ target: 'conversation-550e8400-e29b-41d4-a716-446655440003' });
  });
});

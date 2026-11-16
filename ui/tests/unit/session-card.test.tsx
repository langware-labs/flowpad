import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteWorkerSession, RemoteWorkerSessionStatus } from '@sdk';
import { SessionCard } from '@src/components/conversation/SessionCard';

const openDock = vi.fn();
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: { openDock } }) }));

const SID = 'a1a1a1a1-0000-4000-8000-000000000001';

function session(status: string, over: Partial<RemoteWorkerSession> = {}) {
  return new RemoteWorkerSession({
    id: SID,
    status,
    host_name: 'Sam',
    guest_name: 'Dana',
    ...over,
  } as Partial<RemoteWorkerSession>);
}

function renderCard(props: Partial<Parameters<typeof SessionCard>[0]> = {}) {
  const onOpen = vi.fn();
  render(
    <SessionCard
      sessionId={SID}
      session={props.session ?? null}
      role={props.role ?? 'guest'}
      promptCount={props.promptCount ?? 2}
      replyCount={props.replyCount ?? 1}
      onOpen={props.onOpen ?? onOpen}
      onApprove={props.onApprove}
      onDecline={props.onDecline}
      onDisconnect={props.onDisconnect}
      lastPromptFailed={props.lastPromptFailed}
      onRetry={props.onRetry}
      runningPrompt={props.runningPrompt}
      chatProcessId={props.chatProcessId}
      onRun={props.onRun}
      resultText={props.resultText}
      onRunAgain={props.onRunAgain}
      resultHeld={props.resultHeld}
      promptText={props.promptText}
      runSummary={props.runSummary}
    />,
  );
  return { onOpen };
}

describe("SessionCard — the session's one line in the conversation", () => {
  afterEach(() => cleanup());

  it('names the session after the other side and its status — no Open button', () => {
    renderCard({ session: session(RemoteWorkerSessionStatus.PENDING), role: 'guest' });
    expect(screen.getByTestId('session-card-name').textContent).toBe('Live session · Sam');
    expect(screen.getByTestId('session-card-status').textContent).toBe('awaiting approval');
    expect(screen.queryByTestId('session-card-open')).toBeNull();
    expect(screen.queryByText('Open')).toBeNull();
  });

  it('the whole line opens the session and never touches window.location', () => {
    const before = window.location.href;
    const { onOpen } = renderCard({ session: session(RemoteWorkerSessionStatus.IDLE) });
    fireEvent.click(screen.getByTestId('session-card'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe(before);
  });

  it('host + pending: Approve/Decline once, on the line', async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    const { onOpen } = renderCard({
      session: session(RemoteWorkerSessionStatus.PENDING),
      role: 'host',
      onApprove,
      onDecline: vi.fn(),
    });
    expect(screen.getByTestId('session-card-name').textContent).toBe('Live session · Dana');
    expect(screen.getByTestId('session-card-status').textContent).toBe('wants to run prompts on your machine');
    fireEvent.click(screen.getByTestId('session-card-approve'));
    expect(onOpen).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('session-card-decline')).toBeTruthy();
    expect(screen.queryByTestId('session-card-disconnect')).toBeNull();
  });

  it('host + pending: Approve (this session only) and Decline', async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    const onDecline = vi.fn().mockResolvedValue(undefined);
    renderCard({
      session: session(RemoteWorkerSessionStatus.PENDING),
      role: 'host',
      onApprove,
      onDecline,
    });
    expect(screen.getByTestId('session-card-approve').textContent).toBe('Approve');
    expect(screen.getByTestId('session-card-approve').className).toContain('bg-blue-600');
    fireEvent.click(screen.getByTestId('session-card-approve'));
    await Promise.resolve();
    await Promise.resolve();
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onDecline).not.toHaveBeenCalled();
  });

  it('guest + pending: no Approve', () => {
    renderCard({
      session: session(RemoteWorkerSessionStatus.PENDING),
      role: 'guest',
      onApprove: vi.fn(),
    });
    expect(screen.queryByTestId('session-card-approve')).toBeNull();
  });

  it.each(['host', 'guest'] as const)('%s + live: message count, time since approval, red Disconnect', async (role) => {
    const onDisconnect = vi.fn().mockResolvedValue(undefined);
    const approvedAt = new Date(Date.now() - 125_000).toISOString();
    renderCard({
      session: session(RemoteWorkerSessionStatus.IDLE, { approved_at: approvedAt }),
      role,
      promptCount: 2,
      replyCount: 1,
      onApprove: vi.fn(),
      onDisconnect,
    });
    expect(screen.getByTestId('session-card-status').textContent).toBe('connected');
    expect(screen.getByTestId('session-card-counts').textContent).toBe('3 messages');
    expect(screen.getByTestId('session-card-elapsed').textContent).toMatch(/^2:0\d$/);
    expect(screen.queryByTestId('session-card-approve')).toBeNull(); // approval is once
    const disconnect = screen.getByTestId('session-card-disconnect');
    expect(disconnect.className).toContain('bg-destructive');
    fireEvent.click(disconnect);
    await Promise.resolve();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('pulses while a prompt runs', () => {
    renderCard({ session: session(RemoteWorkerSessionStatus.RUNNING) });
    expect(screen.getByTestId('session-card-status').textContent).toBe('working…');
    expect(screen.getByTestId('session-card').querySelector('.animate-pulse')).toBeTruthy();
  });

  it('names the running prompt by its first line, on either side, whatever the mirror status says', () => {
    // The guest's mirror stays IDLE through a turn (nothing is sent when one starts).
    renderCard({ session: session(RemoteWorkerSessionStatus.IDLE), runningPrompt: 'list the files\nthen count them' });
    expect(screen.getByTestId('session-card-prompt').textContent).toBe('❯ list the files');
    expect(screen.queryByTestId('session-card-status')).toBeNull();
    expect(screen.getByTestId('session-card').querySelector('.animate-pulse')).toBeTruthy();
  });

  it('host: an icon opens the chat the session runs in, without opening the session', () => {
    openDock.mockClear();
    const { onOpen } = renderCard({
      session: session(RemoteWorkerSessionStatus.RUNNING),
      role: 'host',
      chatProcessId: '911219a8-bff1-4a69-9cdb-438e33a43a5c',
    });
    fireEvent.click(screen.getByTestId('live-session-open-chat'));
    expect(onOpen).not.toHaveBeenCalled();
    expect(openDock).toHaveBeenCalledTimes(1);
    expect(String(openDock.mock.calls[0][0].pointer)).toContain('911219a8-bff1-4a69-9cdb-438e33a43a5c');
  });

  it('a failed last prompt keeps the session live and offers the guest Retry, once', async () => {
    const onRetry = vi.fn().mockResolvedValue(undefined);
    const { onOpen } = renderCard({
      session: session(RemoteWorkerSessionStatus.ERROR),
      lastPromptFailed: true,
      onRetry,
    });
    expect(screen.getByTestId('session-card').getAttribute('data-status')).toBe('active');
    expect(screen.getByTestId('session-card-failed').textContent).toBe('Last prompt failed');
    fireEvent.click(screen.getByTestId('session-card-retry'));
    expect(onOpen).not.toHaveBeenCalled();
    expect((screen.getByTestId('session-card-retry') as HTMLButtonElement).disabled).toBe(true); // busy guard
    await Promise.resolve();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("the host sees the failure but no Retry (it is the guest's prompt)", () => {
    renderCard({ session: session(RemoteWorkerSessionStatus.ERROR), role: 'host', lastPromptFailed: true });
    expect(screen.getByTestId('session-card-failed')).toBeTruthy();
    expect(screen.queryByTestId('session-card-retry')).toBeNull();
  });

  it.each([
    [RemoteWorkerSessionStatus.ENDED, 'ended'],
    [RemoteWorkerSessionStatus.DECLINED, 'declined'],
  ])('%s is text only — no buttons, no counter', (status, text) => {
    renderCard({
      session: session(status),
      role: 'host',
      onApprove: vi.fn(),
      onDecline: vi.fn(),
      onDisconnect: vi.fn(),
    });
    expect(screen.getByTestId('session-card-status').textContent).toBe(text);
    for (const action of ['approve', 'decline', 'disconnect', 'retry']) {
      expect(screen.queryByTestId(`session-card-${action}`)).toBeNull();
    }
    expect(screen.queryByTestId('session-card-counts')).toBeNull();
  });

  it('null session renders "requesting"', () => {
    renderCard({ session: null });
    expect(screen.getByTestId('session-card').getAttribute('data-status')).toBe('requesting');
  });
});

describe('SessionCard — the 4-hour length cap', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('flips a connected card to ended when the cap passes, with no Disconnect', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T11:59:00Z'));
    renderCard({
      session: session(RemoteWorkerSessionStatus.IDLE, { approved_at: '2026-10-07T08:00:00Z' }),
      onDisconnect: async () => {},
    });
    expect(screen.getByTestId('session-card').dataset.status).toBe('active');
    expect(screen.queryByTestId('session-card-disconnect')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId('session-card').dataset.status).toBe('ended');
    expect(screen.queryByTestId('session-card-disconnect')).toBeNull();
  });
});

describe('SessionCard — a prompt request (prompt_limit = 1)', () => {
  afterEach(() => cleanup());
  const pr = (status: string, over: Partial<RemoteWorkerSession> = {}) => session(status, { prompt_limit: 1, ...over });

  it('host, pending: "Prompt request · <guest>" with Run & Update / Run / Decline, no live-session words', async () => {
    const onRun = vi.fn(async (_policy: string) => {});
    renderCard({ session: pr(RemoteWorkerSessionStatus.PENDING), role: 'host', onRun, onDecline: vi.fn(async () => {}) });
    expect(screen.getByTestId('session-card-name').textContent).toBe('Prompt request · Dana');
    expect(screen.getByTestId('session-card-status').textContent).toBe('not run yet');
    expect(screen.getByTestId('session-card-run-update').textContent).toBe('Run & Update Dana');
    expect(screen.getByTestId('session-card-run')).toBeTruthy();
    expect(screen.getByTestId('session-card-decline')).toBeTruthy();
    expect(screen.queryByTestId('session-card-approve')).toBeNull();
    expect(screen.queryByText(/Live session|Needs your approval/)).toBeNull();
    await act(async () => fireEvent.click(screen.getByTestId('session-card-run')));
    expect(onRun).toHaveBeenLastCalledWith('review');
    await act(async () => fireEvent.click(screen.getByTestId('session-card-run-update')));
    expect(onRun).toHaveBeenLastCalledWith('auto');
  });

  it('guest, running: Open and Cancel', () => {
    renderCard({ session: pr(RemoteWorkerSessionStatus.RUNNING), role: 'guest', onDisconnect: vi.fn(async () => {}) });
    expect(screen.getByTestId('session-card-status').textContent).toBe('running');
    expect(screen.getByTestId('session-card-open')).toBeTruthy();
    expect(screen.getByTestId('session-card-disconnect').textContent).toBe('Cancel');
  });

  it('done: the guest gets the update under the row; the host sees it was sent (auto only)', () => {
    renderCard({ session: pr(RemoteWorkerSessionStatus.ENDED, { prompts_used: 1 }), role: 'guest', resultText: 'Darwin' });
    expect(screen.getByTestId('session-card').dataset.status).toBe('done');
    expect(screen.getByTestId('session-card-update').textContent).toContain('Darwin');
    cleanup();
    renderCard({ session: pr(RemoteWorkerSessionStatus.ENDED, { prompts_used: 1, reply_policy: 'auto' }), role: 'host' });
    expect(screen.getByTestId('session-card-update-sent').textContent).toBe('✓ Update sent to Dana');
    cleanup();
    renderCard({ session: pr(RemoteWorkerSessionStatus.ENDED, { prompts_used: 1, reply_policy: 'review' }), role: 'host' });
    expect(screen.queryByTestId('session-card-update-sent')).toBeNull(); // Run: nothing went back
  });

  it('done: the host sees its own answer and opens the run; the guest can run it again', async () => {
    const done = pr(RemoteWorkerSessionStatus.ENDED, { prompts_used: 1 });
    renderCard({ session: done, role: 'host', resultText: 'Darwin', chatProcessId: 'p1' });
    expect(screen.getByTestId('session-card-update').textContent).toContain('Your answer');
    expect(screen.getByTestId('session-card-update').textContent).toContain('Darwin');
    expect(screen.getByTestId('live-session-open-chat')).toBeTruthy();
    expect(screen.queryByTestId('session-card-run-again')).toBeNull();
    cleanup();
    const onRunAgain = vi.fn(async () => {});
    renderCard({ session: done, role: 'guest', resultText: 'Darwin', onRunAgain });
    await act(async () => fireEvent.click(screen.getByTestId('session-card-run-again')));
    expect(onRunAgain).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('live-session-open-chat')).toBeNull(); // the run lives on the host
  });

  it('done: the host can run it again too; the guest opens the run the host sent back', async () => {
    const done = pr(RemoteWorkerSessionStatus.ENDED, { prompts_used: 1 });
    const onRunAgain = vi.fn(async () => {});
    renderCard({ session: done, role: 'host', resultText: 'Darwin', onRunAgain });
    await act(async () => fireEvent.click(screen.getByTestId('session-card-run-again')));
    expect(onRunAgain).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('session-card-view-run')).toBeNull(); // the host has the run itself
    cleanup();
    renderCard({ session: done, role: 'host', resultText: 'Darwin', resultHeld: true }); // it ran with Run
    expect(screen.getByTestId('session-card-update').textContent).toContain('Your answer · not sent to Dana yet');
    cleanup();
    const { onOpen } = renderCard({
      session: done,
      role: 'guest',
      resultText: 'Darwin',
      promptText: 'which OS?',
      runSummary: { steps: [{ tool: 'Bash' }, { tool: 'Edit', path: 'src/a.py' }], files_touched: ['src/a.py'] },
    });
    expect(screen.queryByTestId('prompt-run-summary')).toBeNull();
    await act(async () => fireEvent.click(screen.getByTestId('session-card-view-run')));
    expect(onOpen).not.toHaveBeenCalled();
    const run = screen.getByTestId('prompt-run-summary').textContent ?? '';
    expect(run).toContain("Run on Sam's machine");
    expect(run).toContain('which OS?');
    expect(run).toContain('Darwin');
    expect(screen.getByTestId('prompt-run-steps').textContent).toBe('1Bash2Editsrc/a.py');
    expect(screen.getByTestId('prompt-run-files').textContent).toBe('src/a.py');
  });
});

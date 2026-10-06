import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteWorkerSession, RemoteWorkerSessionStatus } from '@sdk';
import { SessionCard } from '@src/components/conversation/SessionCard';

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
      onApproveOnce={props.onApproveOnce}
      onDecline={props.onDecline}
      onDisconnect={props.onDisconnect}
      lastPromptFailed={props.lastPromptFailed}
      onRetry={props.onRetry}
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

  it('host + pending: Approve (remembers), Approve once, Decline — each its own action', async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    const onApproveOnce = vi.fn().mockResolvedValue(undefined);
    const onDecline = vi.fn().mockResolvedValue(undefined);
    renderCard({
      session: session(RemoteWorkerSessionStatus.PENDING),
      role: 'host',
      onApprove,
      onApproveOnce,
      onDecline,
    });
    expect(screen.getByTestId('session-card-approve').textContent).toBe('Approve');
    expect(screen.getByTestId('session-card-approve').className).toContain('bg-blue-600');
    expect(screen.getByTestId('session-card-approve-once').textContent).toBe('Approve once');
    fireEvent.click(screen.getByTestId('session-card-approve-once'));
    await Promise.resolve();
    await Promise.resolve();
    expect(onApproveOnce).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
    expect(onDecline).not.toHaveBeenCalled();
  });

  it('guest + pending: no Approve', () => {
    renderCard({
      session: session(RemoteWorkerSessionStatus.PENDING),
      role: 'guest',
      onApprove: vi.fn(),
      onApproveOnce: vi.fn(),
    });
    expect(screen.queryByTestId('session-card-approve')).toBeNull();
    expect(screen.queryByTestId('session-card-approve-once')).toBeNull();
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

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteWorkerSession, RemoteWorkerSessionStatus } from '@sdk';
import { SessionCard } from '@src/components/conversation/SessionCard';

const SID = 'a1a1a1a1-0000-4000-8000-000000000001';

function session(status: string, over: Partial<RemoteWorkerSession> = {}) {
  return new RemoteWorkerSession({ id: SID, status, host_name: 'Sam', guest_name: 'Dana', ...over } as Partial<RemoteWorkerSession>);
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
    />,
  );
  return { onOpen };
}

describe('SessionCard', () => {
  afterEach(() => cleanup());

  it('host + pending shows Approve/Decline and calls onApprove once', async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    renderCard({ session: session(RemoteWorkerSessionStatus.PENDING), role: 'host', onApprove });
    expect(screen.getByTestId('session-card').getAttribute('data-status')).toBe('pending');
    expect(screen.getByText(/Dana wants to run prompts here/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('session-card-approve'));
    fireEvent.click(screen.getByTestId('session-card-approve')); // busy guard
    await Promise.resolve();
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('session-card-decline')).toBeTruthy();
  });

  it('guest + pending shows "Awaiting <host>" and no Approve', () => {
    renderCard({ session: session(RemoteWorkerSessionStatus.PENDING), role: 'guest', onApprove: vi.fn() });
    expect(screen.getByText('Awaiting Sam')).toBeTruthy();
    expect(screen.queryByTestId('session-card-approve')).toBeNull();
  });

  it('active shows counts and pulses while running', () => {
    renderCard({ session: session(RemoteWorkerSessionStatus.RUNNING), promptCount: 2, replyCount: 1 });
    expect(screen.getByTestId('session-card').getAttribute('data-status')).toBe('active');
    expect(screen.getByTestId('session-card-counts').textContent).toContain('2 prompts');
    expect(screen.getByTestId('session-card-counts').textContent).toContain('1 reply');
    expect(screen.getByText("Live on Sam's machine")).toBeTruthy();
    expect(screen.getByTestId('session-card').querySelector('.animate-pulse')).toBeTruthy();
  });

  it.each([
    [RemoteWorkerSessionStatus.PAUSED, 'paused'],
    [RemoteWorkerSessionStatus.ENDED, 'ended'],
    [RemoteWorkerSessionStatus.DECLINED, 'declined'],
  ])('%s renders its state and no lifecycle buttons', (status, state) => {
    renderCard({ session: session(status), role: 'host', onApprove: vi.fn(), onDecline: vi.fn() });
    expect(screen.getByTestId('session-card').getAttribute('data-status')).toBe(state);
    expect(screen.queryByTestId('session-card-approve')).toBeNull();
    expect(screen.queryByTestId('session-card-decline')).toBeNull();
  });

  it('Open calls onOpen and never touches window.location', () => {
    const before = window.location.href;
    const { onOpen } = renderCard({ session: session(RemoteWorkerSessionStatus.IDLE) });
    fireEvent.click(screen.getByTestId('session-card-open'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe(before);
  });

  it('null session renders "requesting"', () => {
    renderCard({ session: null });
    expect(screen.getByTestId('session-card').getAttribute('data-status')).toBe('requesting');
  });
});

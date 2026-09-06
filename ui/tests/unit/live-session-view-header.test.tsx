import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowMessage, RemoteWorkerSession, RemoteWorkerSessionStatus } from '@sdk';

vi.mock('@sdk/react/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk/react/hooks')>();
  return { ...actual, useAuth: vi.fn(), useEntitiesQuery: vi.fn() };
});
vi.mock('@src/hooks/entity-hooks/useEntity', () => ({ useEntity: vi.fn() }));
vi.mock('@src/hooks/use-contact-permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@src/hooks/use-contact-permissions')>();
  return {
    ...actual,
    useContactPermissions: vi.fn(() => ({ permissions: [], refetch: vi.fn() })),
    grantContactPermission: vi.fn(),
    revokeContactPermission: vi.fn(),
  };
});
vi.mock('@src/components/conversation/MessageComposer', () => ({
  MessageComposer: (props: { draft?: unknown; liveSessionId?: string }) => (
    <div data-testid={props.draft ? 'mock-draft-composer' : 'mock-composer'} data-session={props.liveSessionId ?? ''} />
  ),
}));

import { useAuth, useEntitiesQuery } from '@sdk/react/hooks';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';
import { LiveSessionView, sessionTitle } from '@src/components/collaboration/LiveSessionView';

const SID = 'a1a1a1a1-0000-4000-8000-000000000001';
const HOST = 'a0a0a0a0-0000-4000-8000-000000000002';
const GUEST = 'b0b0b0b0-0000-4000-8000-000000000003';
const START = 'f1f1f1f1-0000-4000-8000-000000000004';

function session(over: Partial<RemoteWorkerSession> = {}) {
  return new RemoteWorkerSession({
    id: SID,
    conversation_id: 'c0c0c0c0-0000-4000-8000-000000000005',
    status: RemoteWorkerSessionStatus.IDLE,
    host_user_id: HOST,
    guest_user_id: GUEST,
    host_name: 'Sam',
    guest_name: 'Dana',
    starting_message_id: START,
    project_id: 'd0d0d0d0-0000-4000-8000-000000000006',
    ...over,
  } as Partial<RemoteWorkerSession>);
}

const promptMsg = (id: string, text: string, over: Partial<FlowMessage> = {}) =>
  new FlowMessage({ id, remote_worker_session_id: SID, attachment: [{ attachment_type: 'prompt', data: text }], ...over } as Partial<FlowMessage>);
const replyMsg = (id: string, text: string, over: Partial<FlowMessage> = {}) =>
  new FlowMessage({ id, remote_worker_session_id: SID, attachment: [{ attachment_type: 'type_id', data: 'prompt_completion-r1', prompt_preview: text }], ...over } as Partial<FlowMessage>);

function arrange(s: RemoteWorkerSession, messages: FlowMessage[], viewer: string) {
  vi.mocked(useEntity).mockReturnValue({ data: s, refetch: vi.fn() } as never);
  vi.mocked(useEntitiesQuery).mockReturnValue({ data: messages } as never);
  vi.mocked(useAuth).mockReturnValue({ cloudUser: { id: viewer } } as never);
}

describe('LiveSessionView header', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('titles the session after the prompt that opened it', () => {
    arrange(session(), [promptMsg(START, 'Run flow index status\nand summarize'), promptMsg('f2f2f2f2-0000-4000-8000-000000000007', 'why?')], GUEST);
    render(
      <MemoryRouter>
        <LiveSessionView sessionId={SID} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('live-session-title').textContent).toBe('Run flow index status');
  });

  it('host sees the standing-grant checkbox + reply-policy select, guest sees only the select', () => {
    arrange(session(), [promptMsg(START, 'go')], HOST);
    render(
      <MemoryRouter>
        <LiveSessionView sessionId={SID} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('live-session-standing-grant')).toBeTruthy();
    expect(screen.getByTestId('live-session-standing-grant-scope')).toBeTruthy();
    expect(screen.getByTestId('live-session-reply-policy')).toBeTruthy();
    expect(screen.getByTestId('live-session-pause')).toBeTruthy();
    cleanup();
    arrange(session(), [promptMsg(START, 'go')], GUEST);
    render(
      <MemoryRouter>
        <LiveSessionView sessionId={SID} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('live-session-standing-grant')).toBeNull();
    expect(screen.getByTestId('live-session-reply-policy')).toBeTruthy();
  });

  it('a review draft reply renders the draft composer for the host, a sent reply renders as a line', () => {
    arrange(session({ reply_policy: 'review' }), [promptMsg(START, 'go'), replyMsg('e0e0e0e0-0000-4000-8000-000000000008', 'draft answer', { is_draft: true })], HOST);
    render(
      <MemoryRouter>
        <LiveSessionView sessionId={SID} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('live-session-review-draft')).toBeTruthy();
    expect(screen.getByTestId('mock-draft-composer')).toBeTruthy();
    cleanup();
    arrange(session(), [promptMsg(START, 'go'), replyMsg('e1e1e1e1-0000-4000-8000-000000000009', 'sent answer')], GUEST);
    render(
      <MemoryRouter>
        <LiveSessionView sessionId={SID} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('live-session-reply').textContent).toBe('sent answer');
    expect(screen.getByTestId('mock-composer').getAttribute('data-session')).toBe(SID);
  });

  it('sessionTitle keeps the first line, truncated', () => {
    expect(sessionTitle('a\nb')).toBe('a');
    expect(sessionTitle('x'.repeat(100), 10)).toBe('xxxxxxxxx…');
  });
});

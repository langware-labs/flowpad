/**
 * The conversation's plan session is found through the conversation's own context (`PLAN_ROLE` +
 * message id) and fetched by id — never by watching every agentic process (that watch serialized all
 * 1,284 processes and froze the backend on each conversation open).
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess, TypeId, type QueryRequest } from '@sdk';
import { useImplementPlan } from '@src/components/conversation/useImplementPlan';
import { PLAN_ROLE } from '@src/components/conversation/conversation-session-role';

const queries: { request: QueryRequest; enabled: boolean }[] = [];
let rows: unknown[] = [];
let current: unknown = null;
vi.mock('@sdk/react/hooks', () => ({
  useEntity: () => ({ data: current }),
  useEntitiesQuery: (request: QueryRequest, opts: { enabled: boolean }) => {
    queries.push({ request, enabled: opts.enabled });
    return { data: opts.enabled ? rows : undefined };
  },
}));
const openDock = vi.fn();
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: { openDock } }) }));
vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => false }));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), warning: vi.fn() } }));

const PROC_ID = '550e8400-e29b-41d4-a716-446655440001';
const MSG_ID = '550e8400-e29b-41d4-a716-446655440002';

function conversation(planLinked: boolean) {
  return {
    id: '550e8400-e29b-41d4-a716-446655440003',
    plan_sessions_indexed_at: '2026-11-06T00:00:00Z',
    contextOfType: () => (planLinked ? [new TypeId(AgenticProcess.type, PROC_ID)] : []),
    getContextEntryData: () => (planLinked ? { ...PLAN_ROLE, message_id: MSG_ID } : undefined),
    indexPlanSessions: vi.fn(async () => undefined),
  } as never;
}

function render(conv: unknown) {
  current = conv;
  return renderHook(() =>
    useImplementPlan({
      task: null,
      conversationId: '550e8400-e29b-41d4-a716-446655440003',
      conversation: conv as never,
      pointers: [{ type: 'flow_message', id: MSG_ID, ts: '' }] as never,
    }),
  );
}

describe('the plan session comes from the conversation context', () => {
  beforeEach(() => {
    queries.length = 0;
    rows = [];
  });

  it('fetches only the linked session by id, and opens it', () => {
    rows = [{ id: PROC_ID, visible: true, created_date: '2026-11-06T00:00:00Z', terminalDockPointer: { p: 1 } }];
    const { result } = render(conversation(true));
    const last = queries.at(-1)!;
    expect(last.enabled).toBe(true);
    expect(JSON.parse(JSON.stringify((last.request.query as unknown as { match: unknown }).match))).toEqual({
      op: '$IN',
      operands: ['id', [PROC_ID]],
    });
    result.current.openPlanSession?.();
    expect(openDock).toHaveBeenCalledWith({ p: 1 });
  });

  it('asks for no process at all when the conversation links none', () => {
    const { result } = render(conversation(false));
    expect(queries.every((q) => !q.enabled)).toBe(true);
    expect(result.current.openPlanSession).toBeUndefined();
  });
});

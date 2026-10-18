import { describe, expect, it, vi } from 'vitest';
import type { AgenticProcess } from '@sdk';
import { openableValue } from '@src/components/conversation/ConversationAutomationChip';
import { automationState, latestSession, returnedValue } from '@src/hooks/conversation/useMessageAutomationSessions';

const session = (over: Record<string, unknown>) =>
  ({ id: 'p', status: 'running', busy: false, created_date: '2026-10-14T10:00:00Z', context_data: {}, ...over }) as unknown as AgenticProcess;

describe('an automation run on a conversation', () => {
  it('offers what the run returned, labelled by its kind, and opens that file', () => {
    const navigation = { openMachinePath: vi.fn() };
    const value = openableValue(session({ context_data: { output_value: '/runs/p/output/review.value.json' } }), navigation);
    expect(value?.label).toBe('review');
    value?.onOpen();
    expect(navigation.openMachinePath.mock.calls[0][0]).toBe('/runs/p/output/review.value.json');
  });

  it('offers nothing before the run returns a value', () => {
    expect(returnedValue(session({}))).toBeNull();
  });

  it('is working only while a turn is in flight — an open session whose turn ended is done', () => {
    expect(automationState(session({ busy: true }))).toBe('working');
    expect(automationState(session({ busy: false }))).toBe('done');
    expect(automationState(session({ status: 'failed' }))).toBe('failed');
  });

  it('the header follows the newest run', () => {
    const older = session({ id: 'a', created_date: '2026-10-14T09:00:00Z', context_data: { automation: { name: 'r' } } });
    const newer = session({ id: 'b', created_date: '2026-10-14T11:00:00Z', context_data: { automation: { name: 'r' } } });
    expect(latestSession(new Map([['m1', newer], ['m2', older]]))?.id).toBe('b');
    expect(latestSession(new Map())).toBeNull();
  });
});

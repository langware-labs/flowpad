import type { GenericEntry } from '@sdk';
import { groupEntriesByTurn } from '@src/components/lens-viewer/shared/transcript-features/group-entries';
import { describe, expect, it } from 'vitest';

describe('transcript skill-call projection', () => {
  it('renders a normalized skill invocation as an operation row', () => {
    const skill = {
      id: 'skill-1',
      kind: 'skill_call',
      timestamp: '2026-07-28T12:00:00Z',
      session_id: 'session-1',
      skill_name: 'rca',
      invocation_kind: 'file_load',
      tool_name: 'read',
      tool_use_id: 'tool-1',
    } as GenericEntry;

    const rows = groupEntriesByTurn([skill]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'skill-1',
      role: 'operation',
      kind: 'skill_call',
      operation: skill,
    });
    expect(rows[0].searchHaystack).toContain('rca');
  });
});

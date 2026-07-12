import { describe, expect, it } from 'vitest';
import { FlowData } from '@sdk/flow_processing/flow-data';
import { FlowElementTypes } from '@sdk/flow_processing/flow-element-types';
import { groupTurnEvents } from '@src/components/floating-chat/groupTurnEvents';

const ts = (i: number) => new Date(Date.UTC(2026, 0, 1, 10, 0, i)).toISOString();

function toolCall(toolName: string, toolUseId: string, i: number): FlowData {
  return new FlowData(
    FlowElementTypes.TOOL_CALL,
    JSON.stringify({ tool_call_id: toolUseId, args: {} }),
    { i: String(i), t: ts(i), 'data-type': 'object', 'tool-name': toolName },
  );
}

function toolResult(toolUseId: string, i: number): FlowData {
  return new FlowData(
    FlowElementTypes.TOOL_RESULT,
    JSON.stringify({ tool_call_id: toolUseId, content: 'ok' }),
    { i: String(i), t: ts(i), 'data-type': 'object', 'tool-use-id': toolUseId },
  );
}

function userMessage(text: string, i: number, meta = false): FlowData {
  const attrs: Record<string, string> = { i: String(i), t: ts(i), role: 'user' };
  if (meta) attrs['is-meta'] = 'true';
  return new FlowData(FlowElementTypes.USER_MESSAGE, text, attrs);
}

describe('groupTurnEvents — Skill tool events collapse into the meta chip', () => {
  it('drops the Skill TOOL_CALL and its TOOL_RESULT from dense groups', () => {
    // Real skill-use shape: Skill call → meta injection message → skill result,
    // then an ordinary tool pair that must survive.
    const items = [
      userMessage('do the thing', 0),
      toolCall('Skill', 'tu-skill', 1),
      userMessage('Base directory for this skill: /skills/flowpad-assistance', 2, true),
      toolResult('tu-skill', 3),
      toolCall('Bash', 'tu-bash', 4),
      toolResult('tu-bash', 5),
    ];

    const groups = groupTurnEvents(items);
    // user msg, meta msg, one dense group with just the Bash pair
    expect(groups.map((g) => g.kind)).toEqual(['message', 'message', 'dense']);
    const dense = groups[2];
    if (dense.kind !== 'dense') throw new Error('expected dense group');
    expect(dense.events).toHaveLength(2);
    expect(dense.events[0].attributes['tool-name']).toBe('Bash');
  });

  it('keeps non-Skill tool results intact even without a matching call in the group', () => {
    const items = [
      toolResult('tu-orphan', 0), // orphan result of a NON-skill call — must stay
      toolCall('Skill', 'tu-skill', 1),
      toolResult('tu-skill', 2),
    ];
    const groups = groupTurnEvents(items);
    expect(groups).toHaveLength(1);
    const dense = groups[0];
    if (dense.kind !== 'dense') throw new Error('expected dense group');
    expect(dense.events).toHaveLength(1);
    expect(dense.events[0].elementType).toBe(FlowElementTypes.TOOL_RESULT);
  });
});

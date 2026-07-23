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

describe('groupTurnEvents — the skill name comes off the structured call', () => {
  function skillCall(skillName: string, toolUseId: string, i: number): FlowData {
    // Shape the backend now emits on BOTH the live stream and a replay:
    // SkillCallEntry.to_flow_data() carries `skill-name` + `skill_name`.
    return new FlowData(
      FlowElementTypes.TOOL_CALL,
      JSON.stringify({ tool_call_id: toolUseId, skill_name: skillName, args: { skill: skillName } }),
      {
        i: String(i),
        t: ts(i),
        'data-type': 'object',
        'tool-name': 'Skill',
        'skill-name': skillName,
        subtype: 'skill_call',
      },
    );
  }

  it('stamps the dropped call’s skill name onto the meta message group', () => {
    const groups = groupTurnEvents([
      skillCall('rca', 'tu-skill', 0),
      userMessage('Base directory for this skill: /skills/rca', 1, true),
    ]);

    expect(groups).toHaveLength(1);
    const meta = groups[0];
    if (meta.kind !== 'message') throw new Error('expected message group');
    expect(meta.skillName).toBe('rca');
  });

  it('reads the name from the flow value when the attribute is absent', () => {
    const call = new FlowData(
      FlowElementTypes.TOOL_CALL,
      JSON.stringify({ tool_call_id: 'tu-skill', args: { skill: 'docit' } }),
      { i: '0', t: ts(0), 'data-type': 'object', 'tool-name': 'Skill' },
    );

    const groups = groupTurnEvents([call, userMessage('Base directory for this skill: /s/docit', 1, true)]);

    const meta = groups[0];
    if (meta.kind !== 'message') throw new Error('expected message group');
    expect(meta.skillName).toBe('docit');
  });

  it('leaves skillName unset for an ordinary meta message', () => {
    const groups = groupTurnEvents([userMessage('some system note', 0, true)]);

    const meta = groups[0];
    if (meta.kind !== 'message') throw new Error('expected message group');
    expect(meta.skillName).toBeUndefined();
  });

  it('does not leak a skill name onto a later unrelated meta message', () => {
    const groups = groupTurnEvents([
      skillCall('rca', 'tu-skill', 0),
      userMessage('Base directory for this skill: /skills/rca', 1, true),
      userMessage('an unrelated system note', 2, true),
    ]);

    const second = groups[1];
    if (second.kind !== 'message') throw new Error('expected message group');
    expect(second.skillName).toBeUndefined();
  });
});

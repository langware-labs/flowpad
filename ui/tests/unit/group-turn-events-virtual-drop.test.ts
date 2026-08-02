/**
 * Derivation is ADDITIVE: the backend appends a virtual entry BESIDE its
 * physical source instead of replacing it, so the stream now carries both
 * halves of every refinement (`shell_command → flow_command → artifact`).
 *
 * Rendered naively that is two chips for one command — and worse, the two
 * TOOL_CALLs share a `tool_use_id` (the refinement INHERITS it, because that is
 * the key the vendor's tool result carries). `pairToolEvents` keys
 * `callIndexById` by that id, so the second call overwrites the first and steals
 * the result: the physical chip is then stuck "in flight" forever.
 *
 * The rule is generic, not per-kind: an entry that is the `derived_from` of
 * another entry PRESENT in the same stream is suppressed. Only the leaf of a
 * chain renders, and a TOOL_RESULT is dropped only when no surviving call still
 * claims its id — never merely because one of its calls went away.
 */
import { describe, expect, it } from 'vitest';
import { FlowData } from '@sdk/flow_processing/flow-data';
import { FlowElementTypes } from '@sdk/flow_processing/flow-element-types';
import { groupTurnEvents, pairToolEvents } from '@src/components/floating-chat/groupTurnEvents';

const ts = (i: number) => new Date(Date.UTC(2026, 0, 1, 10, 0, i)).toISOString();

interface EntryShape {
  id: string;
  kind: string;
  toolUseId: string;
  toolName?: string;
  derivedFrom?: string;
  virtual?: boolean;
  skillName?: string;
}

/** A TOOL_CALL frame carrying the `process_entry` envelope the backend ships. */
function call(i: number, e: EntryShape): FlowData {
  const attrs: Record<string, string> = {
    i: String(i),
    t: ts(i),
    'data-type': 'object',
    subtype: e.kind,
    'tool-name': e.toolName ?? 'Bash',
    'tool-use-id': e.toolUseId,
  };
  if (e.skillName) attrs['skill-name'] = e.skillName;
  const fd = new FlowData(
    FlowElementTypes.TOOL_CALL,
    JSON.stringify({ tool_call_id: e.toolUseId, args: {} }),
    attrs,
  );
  fd.processEntry = {
    transcript_entry: {
      id: e.id,
      kind: e.kind,
      tool_use_id: e.toolUseId,
      virtual: e.virtual ?? !!e.derivedFrom,
      derived_from: e.derivedFrom ?? null,
    },
  };
  return fd;
}

function result(i: number, toolUseId: string, entryId: string): FlowData {
  const fd = new FlowData(
    FlowElementTypes.TOOL_RESULT,
    JSON.stringify({ tool_call_id: toolUseId, content: 'ok' }),
    { i: String(i), t: ts(i), 'data-type': 'object', subtype: 'tool_result', 'tool-use-id': toolUseId },
  );
  fd.processEntry = {
    transcript_entry: { id: entryId, kind: 'tool_result', virtual: false, derived_from: null },
  };
  return fd;
}

function userMessage(text: string, i: number, meta = false): FlowData {
  const attrs: Record<string, string> = { i: String(i), t: ts(i), role: 'user' };
  if (meta) attrs['is-meta'] = 'true';
  return new FlowData(FlowElementTypes.USER_MESSAGE, text, attrs);
}

function denseEvents(items: FlowData[]): FlowData[] {
  const groups = groupTurnEvents(items);
  const dense = groups.filter((g) => g.kind === 'dense');
  return dense.flatMap((g) => (g.kind === 'dense' ? g.events : []));
}

/** The whole chain a real `flow artifact …` shell command now produces. */
const chain = () => [
  call(0, { id: 'e1', kind: 'shell_command', toolUseId: 'tu-1' }),
  call(1, { id: 'e1:flow_command', kind: 'flow_command', toolUseId: 'tu-1', derivedFrom: 'e1' }),
  call(2, { id: 'e1:artifact', kind: 'artifact', toolUseId: 'tu-1', derivedFrom: 'e1:flow_command' }),
  result(3, 'tu-1', 'e2'),
];

describe('groupTurnEvents — only the leaf of a derivation chain renders', () => {
  it('drops the physical twin when its refinement is present', () => {
    const events = denseEvents([
      call(0, { id: 'e1', kind: 'shell_command', toolUseId: 'tu-1' }),
      call(1, { id: 'e1:flow_command', kind: 'flow_command', toolUseId: 'tu-1', derivedFrom: 'e1' }),
      result(2, 'tu-1', 'e2'),
    ]);

    expect(events.map((e) => e.attributes.subtype)).toEqual(['flow_command', 'tool_result']);
  });

  it('drops BOTH ancestors of a two-link chain, keeping only the leaf', () => {
    const events = denseEvents(chain());

    expect(events.map((e) => e.attributes.subtype)).toEqual(['artifact', 'tool_result']);
  });

  it('keeps the physical entry when NO refinement follows it', () => {
    const events = denseEvents([
      call(0, { id: 'e1', kind: 'shell_command', toolUseId: 'tu-1' }),
      result(1, 'tu-1', 'e2'),
    ]);

    expect(events.map((e) => e.attributes.subtype)).toEqual(['shell_command', 'tool_result']);
  });

  it('leaves the surviving leaf paired with the result, not stuck in flight', () => {
    // The regression this rule exists for: two TOOL_CALLs sharing a tool_use_id
    // make `callIndexById` point at the LAST one, so the first is orphaned.
    const { pairs, orphanResults } = pairToolEvents(denseEvents(chain()));

    expect(pairs).toHaveLength(1);
    expect(pairs[0].call.attributes.subtype).toBe('artifact');
    expect(pairs[0].result).not.toBeNull();
    expect(orphanResults).toHaveLength(0);
  });

  it('does not suppress an entry whose refinement is absent from the stream', () => {
    // A refinement that never arrived (truncated stream) must not silently
    // erase the physical row — suppression is driven by what IS present.
    const events = denseEvents([
      call(0, { id: 'e1', kind: 'shell_command', toolUseId: 'tu-1' }),
      call(1, { id: 'e9', kind: 'shell_command', toolUseId: 'tu-9' }),
    ]);

    expect(events).toHaveLength(2);
  });

  it('keeps a TOOL_RESULT whose call was refined — the leaf still claims the id', () => {
    const events = denseEvents(chain());

    expect(events.some((e) => e.elementType === FlowElementTypes.TOOL_RESULT)).toBe(true);
  });

  it('retracts a source already sealed into a committed dense group', () => {
    // Defensive: derivation appends the refinement immediately after its source,
    // but nothing in this module may DEPEND on adjacency.
    const groups = groupTurnEvents([
      call(0, { id: 'e1', kind: 'shell_command', toolUseId: 'tu-1' }),
      userMessage('interleaved', 1),
      call(2, { id: 'e1:flow_command', kind: 'flow_command', toolUseId: 'tu-1', derivedFrom: 'e1' }),
    ]);

    const all = groups.flatMap((g) => (g.kind === 'dense' ? g.events : []));
    expect(all.map((e) => e.attributes.subtype)).toEqual(['flow_command']);
  });
});

describe('groupTurnEvents — a skill invocation is one chip, on every worker', () => {
  it('drops a codex skill call (tool-name `shell`), leaving a single chip', () => {
    // Codex has no Skill tool: the parser emits a physical `shell` tool-use AND
    // a SkillCallEntry beside it. The old drop matched `tool-name === 'Skill'`,
    // so codex rendered BOTH — two chips for one command.
    const events = denseEvents([
      call(0, {
        id: 'c1:skill_call',
        kind: 'skill_call',
        toolUseId: 'c1:skill',
        toolName: 'shell',
        skillName: 'rca',
      }),
      call(1, { id: 'c1:tool_use', kind: 'tool_use', toolUseId: 'c1', toolName: 'shell' }),
      result(2, 'c1', 'c1:tool_result'),
    ]);

    expect(events.map((e) => e.attributes.subtype)).toEqual(['tool_use', 'tool_result']);
  });

  it('still harvests the skill name for the meta chip', () => {
    const groups = groupTurnEvents([
      call(0, {
        id: 'c1:skill_call',
        kind: 'skill_call',
        toolUseId: 'c1:skill',
        toolName: 'shell',
        skillName: 'rca',
      }),
      userMessage('Base directory for this skill: /skills/rca', 1, true),
    ]);

    const meta = groups[0];
    if (meta.kind !== 'message') throw new Error('expected message group');
    expect(meta.skillName).toBe('rca');
  });
});

/**
 * The `flow artifact` chip.
 *
 * THE assertion in this file: a chip's `.target` is the REFERENCED asset — the
 * skill, doc, subagent or app the run produced — never the Artifact row that
 * records it. The Artifact is bookkeeping; clicking the chip must open the
 * thing, not its receipt. `expect(target.typeid).not.toBe(ARTIFACT_TYPEID)` is
 * the guard, because both are entities and both are one string away from each
 * other in the payload.
 *
 * Frames arrive exactly as the derive layer produces them:
 * `flow artifact <subverb> <target>` → `{verb:'artifact', subverb, target}`,
 * identical on claude / codex / copilot (`_TARGETED` in
 * flow_sdk/transcript_analyzer/derive.py includes entity, file and webapp).
 */
import { describe, expect, it } from 'vitest';
import { FlowData } from '@sdk/flow_processing/flow-data';
import { FlowElementTypes } from '@sdk/flow_processing/flow-element-types';
import { describeEvent } from '@src/components/floating-chat/toolEventDescriptor';

/** The receipt. No chip may ever point here. */
const ARTIFACT_TYPEID = 'artifact-11111111-0000-4000-8000-000000000001';

const SKILL_TYPEID = 'skill-22222222-0000-4000-8000-000000000002';
const SUBAGENT_TYPEID = 'subagent-33333333-0000-4000-8000-000000000003';
const DOC_TYPEID = 'markdown-44444444-0000-4000-8000-000000000004';

function semanticFrame(entry: Record<string, unknown>, attributes: Record<string, string> = {}): FlowData {
  const fd = new FlowData(
    FlowElementTypes.TOOL_CALL,
    JSON.stringify({ tool_call_id: 'tu-1', args: {} }),
    { i: '0', t: '2026-08-01T10:00:00Z', 'data-type': 'object', subtype: String(entry.kind), ...attributes },
  );
  fd.processEntry = { transcript_entry: entry };
  return fd;
}

const artifactFrame = (subverb: string | null, target: string | null) =>
  semanticFrame({ kind: 'flow_command', verb: 'artifact', subverb, target, command: 'flow artifact' });

describe('describeEvent — flow artifact chips', () => {
  it('labels the chip by the verb', () => {
    const d = describeEvent(artifactFrame('entity', DOC_TYPEID));

    expect(d.label).toBe('flow artifact');
    expect(d.detail).toBe(DOC_TYPEID);
  });

  it.each([
    ['skill', SKILL_TYPEID, 'skill'],
    ['subagent', SUBAGENT_TYPEID, 'subagent'],
    ['doc', DOC_TYPEID, 'markdown'],
  ])('targets the referenced %s, not the artifact that records it', (_name, typeid, type) => {
    const d = describeEvent(artifactFrame('entity', typeid));

    expect(d.target).toEqual({ kind: 'entity', typeid, type });
    // The whole point of the consolidation: the receipt is not the deliverable.
    expect((d.target as { typeid: string }).typeid).not.toBe(ARTIFACT_TYPEID);
    expect((d.target as { type: string }).type).not.toBe('artifact');
  });

  it('targets the file a `flow artifact file` addressed', () => {
    const d = describeEvent(artifactFrame('file', '/repo/out/report.md'));

    expect(d.target).toEqual({ kind: 'vfs', path: '/repo/out/report.md' });
  });

  it('targets the port preview a `flow artifact webapp` addressed', () => {
    const d = describeEvent(artifactFrame('webapp', '3000'));

    expect(d.target).toEqual({ kind: 'webapp', port: 3000 });
  });

  it('leaves an unresolvable reference unclickable rather than guessing', () => {
    expect(describeEvent(artifactFrame('entity', 'not-a-typeid')).target).toBeNull();
    expect(describeEvent(artifactFrame('webapp', 'not-a-port')).target).toBeNull();
    expect(describeEvent(artifactFrame(null, null)).target).toBeNull();
  });

  it('reads the same frame off flow-* attributes when no process_entry is attached', () => {
    const fd = new FlowData(
      FlowElementTypes.TOOL_CALL,
      JSON.stringify({ tool_call_id: 'tu-1', args: {} }),
      {
        i: '0',
        t: 'x',
        'data-type': 'object',
        subtype: 'flow_command',
        'flow-verb': 'artifact',
        'flow-subverb': 'entity',
        'flow-target': DOC_TYPEID,
      },
    );

    const d = describeEvent(fd);

    expect(d.label).toBe('flow artifact');
    expect(d.target).toEqual({ kind: 'entity', typeid: DOC_TYPEID, type: 'markdown' });
  });
});

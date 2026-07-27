import { describe, expect, it } from 'vitest';
import { FlowData } from '@sdk/flow_processing/flow-data';
import { FlowElementTypes } from '@sdk/flow_processing/flow-element-types';
import { describeEvent } from '@src/components/floating-chat/toolEventDescriptor';

const TYPE_ID = 'markdown-3f2a1b4c-0000-4000-8000-000000000001';

/**
 * Frames as the backend emits them: a TOOL_CALL whose typed
 * `process_entry.transcript_entry` carries the semantic payload. Identical on
 * the live stream and on replay — that's the point of the consolidation.
 */
function semanticFrame(entry: Record<string, unknown>, attributes: Record<string, string> = {}): FlowData {
  const fd = new FlowData(
    FlowElementTypes.TOOL_CALL,
    JSON.stringify({ tool_call_id: 'tu-1', args: {} }),
    { i: '0', t: '2026-07-23T10:00:00Z', 'data-type': 'object', subtype: String(entry.kind), ...attributes },
  );
  fd.processEntry = { transcript_entry: entry };
  return fd;
}

describe('describeEvent — semantic frames', () => {
  it('describes a file read and targets the path', () => {
    const d = describeEvent(semanticFrame({ kind: 'file_read', path: '/repo/src/app.tsx' }));

    expect(d.label).toBe('Read');
    expect(d.detail).toBe('/repo/src/app.tsx');
    expect(d.target).toEqual({ kind: 'vfs', path: '/repo/src/app.tsx' });
  });

  it('describes a file write and a file edit distinctly', () => {
    const write = describeEvent(semanticFrame({ kind: 'file_write', path: '/repo/a.txt' }));
    const edit = describeEvent(semanticFrame({ kind: 'file_edit', path: '/repo/a.txt' }));

    expect(write.label).toBe('Write');
    expect(edit.label).toBe('Edit');
    expect(write.icon).not.toBe(edit.icon);
    expect(edit.target).toEqual({ kind: 'vfs', path: '/repo/a.txt' });
  });

  it('targets the entity a `flow show entity` addressed', () => {
    const d = describeEvent(
      semanticFrame({ kind: 'flow_command', verb: 'show', subverb: 'entity', target: TYPE_ID }),
    );

    expect(d.label).toBe('flow show');
    expect(d.target).toEqual({ kind: 'entity', typeid: TYPE_ID, type: 'markdown' });
  });

  it('targets the file a `flow show file` addressed', () => {
    const d = describeEvent(
      semanticFrame({ kind: 'flow_command', verb: 'show', subverb: 'file', target: '~/x/index.html' }),
    );

    expect(d.target).toEqual({ kind: 'vfs', path: '~/x/index.html' });
  });

  it('leaves a targetless flow command unclickable', () => {
    const d = describeEvent(
      semanticFrame({ kind: 'flow_command', verb: 'record', subverb: null, target: null, command: 'flow record' }),
    );

    expect(d.label).toBe('flow record');
    expect(d.detail).toBe('flow record');
    expect(d.target).toBeNull();
  });

  it('never targets an entity whose id is not a valid TypeId', () => {
    const d = describeEvent(
      semanticFrame({ kind: 'flow_command', verb: 'show', subverb: 'entity', target: 'not-a-typeid' }),
    );

    expect(d.target).toBeNull();
  });

  it('names the skill without making the dense row the click affordance', () => {
    const d = describeEvent(semanticFrame({ kind: 'skill_call', skill_name: 'rca' }));

    expect(d.label).toBe('Using skill');
    expect(d.detail).toBe('rca');
    expect(d.target).toBeNull(); // the top-level meta chip owns the click
  });

  it('describes a shell command by its command text', () => {
    const d = describeEvent(semanticFrame({ kind: 'shell_command', command: 'ls -la' }));

    expect(d.label).toBe('Run');
    expect(d.detail).toBe('ls -la');
  });
});

describe('describeEvent — fallbacks', () => {
  it('falls back to the subtype attribute when no process_entry is attached', () => {
    const fd = new FlowData(
      FlowElementTypes.TOOL_CALL,
      JSON.stringify({ tool_call_id: 'tu-1', args: { file_path: '/repo/a.txt' } }),
      { i: '0', t: 'x', 'data-type': 'object', subtype: 'file_read', 'tool-name': 'Read' },
    );

    const d = describeEvent(fd);

    expect(d.label).toBe('Read');
    expect(d.target).toEqual({ kind: 'vfs', path: '/repo/a.txt' });
  });

  it('falls back to the legacy tool-name description for pre-consolidation frames', () => {
    const fd = new FlowData(
      FlowElementTypes.TOOL_CALL,
      JSON.stringify({ tool_call_id: 'tu-1', args: { command: 'ls -la' } }),
      { i: '0', t: 'x', 'data-type': 'object', 'tool-name': 'Bash' },
    );

    const d = describeEvent(fd);

    expect(d.label).toBe('Running command');
    expect(d.detail).toBe('ls -la');
    expect(d.target).toBeNull();
  });

  it('never renders a blank row for an unknown tool', () => {
    const fd = new FlowData(
      FlowElementTypes.TOOL_CALL,
      JSON.stringify({ tool_call_id: 'tu-1', args: {} }),
      { i: '0', t: 'x', 'data-type': 'object', 'tool-name': 'mcp__thing__do' },
    );

    expect(describeEvent(fd).label).toBe('Using mcp__thing__do');
  });
});

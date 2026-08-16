/**
 * The per-turn "files created" trace.
 *
 * THE assertions here are the two things that are easy to get wrong and
 * invisible when wrong:
 *
 *  1. A turn is bounded by HUMAN user messages. Framework injections (skills,
 *     the Flowpad prompt envelope) are USER_MESSAGE-shaped `is-meta` frames;
 *     splitting on those shatters one turn into several and scatters its files.
 *  2. The chip row is anchored on the RENDERED row index, not the group index.
 *     Standard mode hides dense groups by default, so the group that carries
 *     the write usually isn't on screen at all — that is precisely the case the
 *     feature exists for, and a group-indexed plan drops every file in it.
 */
import { describe, expect, it } from 'vitest';

import { FlowData } from '@sdk/flow_processing/flow-data';
import { FlowElementTypes } from '@sdk/flow_processing/flow-element-types';
import { createdFilesInGroup, isTurnStart, planTurnCreatedFiles } from '@src/components/floating-chat/createdFiles';
import type { TurnGroup } from '@src/components/floating-chat/groupTurnEvents';

let seq = 0;

function toolFrame(entry: Record<string, unknown>): FlowData {
  const fd = new FlowData(FlowElementTypes.TOOL_CALL, JSON.stringify({ tool_call_id: `tu-${seq++}`, args: {} }), {
    i: String(seq),
    t: '2026-08-01T10:00:00Z',
    'data-type': 'object',
    subtype: String(entry.kind),
  });
  fd.processEntry = { transcript_entry: entry };
  return fd;
}

const wrote = (path: string, extra: Record<string, unknown> = {}) =>
  toolFrame({ kind: 'file_write', path, ...extra });

function dense(...events: FlowData[]): TurnGroup {
  return { kind: 'dense', index: seq++, events };
}

function userMessage(content: string, isMeta = false): TurnGroup {
  const fd = new FlowData(FlowElementTypes.USER_MESSAGE, content, {
    i: String(seq++),
    t: '2026-08-01T10:00:00Z',
    'data-type': 'string',
    ...(isMeta ? { 'is-meta': 'true' } : {}),
  });
  return { kind: 'message', index: seq, flowData: fd };
}

function assistantMessage(content: string): TurnGroup {
  const fd = new FlowData(FlowElementTypes.CHAT, content, {
    i: String(seq++),
    t: '2026-08-01T10:00:00Z',
    'data-type': 'string',
    role: 'assistant',
  });
  return { kind: 'message', index: seq, flowData: fd };
}

/** Every group rendered — the "Show tool calls ON" arrangement. */
const allVisible = (groups: readonly TurnGroup[]) => groups.map(() => true);
/** Dense groups hidden — the Standard-mode DEFAULT arrangement. */
const messagesOnly = (groups: readonly TurnGroup[]) => groups.map((g) => g.kind !== 'dense');

const paths = (files: readonly { path: string }[] | undefined) => (files ?? []).map((f) => f.path);

describe('createdFilesInGroup', () => {
  it('reports a written file with its basename', () => {
    const files = createdFilesInGroup(dense(wrote('/repo/src/new.tsx')));

    expect(files).toEqual([{ path: '/repo/src/new.tsx', name: 'new.tsx' }]);
  });

  it('splits a Windows path on backslashes', () => {
    // Claude passes `tool_input.file_path` through verbatim, so on Windows the
    // chip label is derived from `C:\…` — a POSIX-only basename would render
    // the entire absolute path as the label.
    const files = createdFilesInGroup(dense(wrote('C:\\Users\\a\\b\\new.tsx')));

    expect(files[0].name).toBe('new.tsx');
  });

  it('ignores everything that is not a creation', () => {
    const files = createdFilesInGroup(
      dense(
        toolFrame({ kind: 'file_read', path: '/repo/src/a.ts' }),
        toolFrame({ kind: 'file_edit', path: '/repo/src/a.ts' }),
        toolFrame({ kind: 'shell_command', command: 'npm run build' }),
        toolFrame({ kind: 'flow_command', verb: 'artifact', subverb: 'file', target: '/repo/out.html' }),
        toolFrame({ kind: 'search', query: 'foo' }),
      ),
    );

    expect(files).toEqual([]);
  });

  it('drops a failed write — it created nothing', () => {
    expect(createdFilesInGroup(dense(wrote('/repo/x.ts', { is_error: true })))).toEqual([]);
  });

  it('drops a write the backend flagged as not new', () => {
    expect(createdFilesInGroup(dense(wrote('/repo/x.ts', { is_new: false })))).toEqual([]);
  });

  it('dedupes a path written twice, keeping first-seen order', () => {
    const files = createdFilesInGroup(dense(wrote('/a.ts'), wrote('/b.ts'), wrote('/a.ts')));

    expect(paths(files)).toEqual(['/a.ts', '/b.ts']);
  });

  it('never sees a frame the grouper retracted', () => {
    // Suppression is the grouper's job (`retract` splices a refined row out of
    // `group.events`), so tracing the GROUP inherits it. A trace over the raw
    // item stream would resurrect writes the chat deliberately un-rendered.
    const retracted = dense(wrote('/kept.ts'));

    expect(paths(createdFilesInGroup(retracted))).toEqual(['/kept.ts']);
  });

  it('returns nothing for a message group', () => {
    expect(createdFilesInGroup(userMessage('hello'))).toEqual([]);
  });
});

describe('isTurnStart', () => {
  it('is true for a human user message', () => {
    expect(isTurnStart(userMessage('build me a page'))).toBe(true);
  });

  it('is false for a framework injection', () => {
    expect(isTurnStart(userMessage('Base directory for this skill: …', true))).toBe(false);
  });

  it('is false for an assistant message and for a dense group', () => {
    expect(isTurnStart(assistantMessage('done'))).toBe(false);
    expect(isTurnStart(dense(wrote('/a.ts')))).toBe(false);
  });
});

describe('planTurnCreatedFiles', () => {
  it('anchors a turn on its last rendered row', () => {
    const groups = [userMessage('go'), dense(wrote('/a.ts')), assistantMessage('done')];

    const { byRow } = planTurnCreatedFiles(groups, allVisible(groups), { lastTurnEnded: true });

    // rows: 0 = user, 1 = dense, 2 = assistant
    expect(paths(byRow.get(2))).toEqual(['/a.ts']);
    expect(byRow.get(1)).toBeUndefined();
  });

  it('still lands the row when the writing group is hidden', () => {
    // The whole point: "Show tool calls" is OFF by default in Standard, so the
    // dense group carrying the write is not a rendered row.
    const groups = [userMessage('go'), dense(wrote('/a.ts')), assistantMessage('done')];

    const { byRow } = planTurnCreatedFiles(groups, messagesOnly(groups), { lastTurnEnded: true });

    // rows: 0 = user, 1 = assistant (the dense group renders nothing)
    expect(paths(byRow.get(1))).toEqual(['/a.ts']);
  });

  it('keeps each turn\u2019s files on its own turn', () => {
    const groups = [
      userMessage('first'),
      dense(wrote('/one.ts')),
      assistantMessage('done'),
      userMessage('second'),
      dense(wrote('/two.ts')),
      assistantMessage('done again'),
    ];

    const { byRow } = planTurnCreatedFiles(groups, allVisible(groups), { lastTurnEnded: true });

    expect(paths(byRow.get(2))).toEqual(['/one.ts']);
    expect(paths(byRow.get(5))).toEqual(['/two.ts']);
  });

  it('does not split a turn on a framework injection', () => {
    // A skill load mid-turn is an `is-meta` USER_MESSAGE. Treating it as a turn
    // start would file the post-skill writes under a turn of their own.
    const groups = [
      userMessage('go'),
      dense(wrote('/before.ts')),
      userMessage('Base directory for this skill: …', true),
      dense(wrote('/after.ts')),
      assistantMessage('done'),
    ];

    const { byRow } = planTurnCreatedFiles(groups, allVisible(groups), { lastTurnEnded: true });

    expect(byRow.size).toBe(1);
    expect(paths(byRow.get(4))).toEqual(['/before.ts', '/after.ts']);
  });

  it('treats the start of the stream as a turn start', () => {
    // An embedded / system-prompted session opens with a hidden prompt envelope
    // and may never carry a non-meta user message. Without this those files
    // belong to no turn and vanish.
    const groups = [userMessage('# You are the \u2026', true), dense(wrote('/a.ts')), assistantMessage('done')];
    const visible = [false, false, true];

    const { byRow } = planTurnCreatedFiles(groups, visible, { lastTurnEnded: true });

    // row 0 is the assistant message — the only thing rendered.
    expect(paths(byRow.get(0))).toEqual(['/a.ts']);
  });

  it('falls back to a leading row when the turn rendered nothing at all', () => {
    const groups = [dense(wrote('/a.ts')), userMessage('now do this'), assistantMessage('ok')];
    const visible = [false, true, true];

    const { byRow } = planTurnCreatedFiles(groups, visible, { lastTurnEnded: true });

    expect(paths(byRow.get(-1))).toEqual(['/a.ts']);
  });

  it('withholds the trailing turn while it is still running', () => {
    const groups = [userMessage('go'), dense(wrote('/a.ts'))];

    expect(planTurnCreatedFiles(groups, allVisible(groups), { lastTurnEnded: false }).byRow.size).toBe(0);
    expect(planTurnCreatedFiles(groups, allVisible(groups), { lastTurnEnded: true }).byRow.size).toBe(1);
  });

  it('still reports an earlier turn while the current one runs', () => {
    // "Ended" for a past turn is structural — a later user message exists — so
    // it does not wait on the live-activity signal.
    const groups = [
      userMessage('first'),
      dense(wrote('/one.ts')),
      assistantMessage('done'),
      userMessage('second'),
      dense(wrote('/two.ts')),
    ];

    const { byRow } = planTurnCreatedFiles(groups, allVisible(groups), { lastTurnEnded: false });

    expect(paths(byRow.get(2))).toEqual(['/one.ts']);
    expect(byRow.size).toBe(1);
  });

  it('dedupes a path written in two groups of one turn', () => {
    const groups = [userMessage('go'), dense(wrote('/a.ts')), dense(wrote('/a.ts')), assistantMessage('done')];

    const { byRow } = planTurnCreatedFiles(groups, allVisible(groups), { lastTurnEnded: true });

    expect(paths(byRow.get(3))).toEqual(['/a.ts']);
  });

  it('plans nothing for a turn that created nothing', () => {
    const groups = [userMessage('hi'), assistantMessage('hello')];

    expect(planTurnCreatedFiles(groups, allVisible(groups), { lastTurnEnded: true }).byRow.size).toBe(0);
  });
});

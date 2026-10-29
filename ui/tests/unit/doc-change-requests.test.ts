import { beforeEach, describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { ProcessStatus, WorkerStatus } from '@sdk';
import { resolveChangeMark } from '@src/components/milkdown-editor/plugins/change-marks';
import { unsentChanges, useDocChangesStore } from '@src/components/assets/editor/changes/use-doc-changes-store';
import {
  buildChangesPrompt,
  sentTurnOutcome,
  settleVerdict,
} from '@src/components/assets/editor/changes/useDocChangesWorker';

const DOC = 'markdown-ccba1273-d718-434d-bca1-74e4be6c662a';
const OTHER = 'markdown-fbb750b5-c487-4703-af9a-ce6d02cb93dd';
const PID = '165956e9-49d0-433f-a502-16330a95ecb7';

const store = () => useDocChangesStore.getState();
const listOf = (doc: string) => store().byDoc[doc];
const change = (quote: string, instruction: string) => ({ quote, from: 1, to: 1 + quote.length, instruction });

beforeEach(() => {
  useDocChangesStore.setState({ byDoc: {} });
});

describe('the change list', () => {
  it('is one list per doc', () => {
    store().add(DOC, change('a', 'shorter'));
    store().add(DOC, change('b', 'bold'));
    store().add(OTHER, change('c', 'rename'));
    expect(listOf(DOC).changes.map((c) => c.instruction)).toEqual(['shorter', 'bold']);
    expect(listOf(OTHER).changes.map((c) => c.instruction)).toEqual(['rename']);
  });

  it('removes one change, and Clear drops the doc entry', () => {
    store().add(DOC, change('a', 'shorter'));
    store().add(DOC, change('b', 'bold'));
    store().remove(DOC, listOf(DOC).changes[0].id);
    expect(listOf(DOC).changes.map((c) => c.instruction)).toEqual(['bold']);
    store().clear(DOC);
    expect(listOf(DOC)).toBeUndefined();
  });

  it('Execute marks the unsent changes sent; a mark made meanwhile stays unsent', () => {
    store().add(DOC, change('a', 'shorter'));
    store().markSent(DOC, PID, true);
    store().add(DOC, change('b', 'bold'));
    expect(listOf(DOC).sentTo).toBe(PID);
    expect(unsentChanges(listOf(DOC)).map((c) => c.instruction)).toEqual(['bold']);
  });

  it('a finished run drops only the sent changes', () => {
    store().add(DOC, change('a', 'shorter'));
    store().markSent(DOC, PID, true);
    store().add(DOC, change('b', 'bold'));
    store().finishRun(DOC);
    expect(listOf(DOC).sentTo).toBeUndefined();
    expect(listOf(DOC).changes.map((c) => [c.instruction, !!c.sent])).toEqual([['bold', false]]);
  });

  it('a failed run puts the sent changes back to unsent, ready to retry', () => {
    store().add(DOC, change('a', 'shorter'));
    store().markSent(DOC, PID, false);
    store().failRun(DOC);
    expect(listOf(DOC).sentTo).toBeUndefined();
    expect(unsentChanges(listOf(DOC))).toHaveLength(1);
  });

  it('a failed run flags the list (New session is offered); the next send clears it', () => {
    store().add(DOC, change('a', 'shorter'));
    store().markSent(DOC, PID, false);
    store().failRun(DOC);
    expect(listOf(DOC).lastFailed).toBe(true);
    store().markSent(DOC, 'another-worker', true);
    expect(listOf(DOC).lastFailed).toBeUndefined();
  });

  it('remembers the worker it last used through finish, failure and Clear (a New session replaces it)', () => {
    store().add(DOC, change('a', 'shorter'));
    store().markSent(DOC, PID, true);
    store().finishRun(DOC);
    expect(listOf(DOC).worker).toBe(PID);
    store().add(DOC, change('b', 'bold'));
    store().markSent(DOC, PID, false);
    store().failRun(DOC);
    expect(listOf(DOC).worker).toBe(PID);
    store().markSent(DOC, 'new-worker', true);
    expect(listOf(DOC).worker).toBe('new-worker');
    store().clear(DOC);
    expect(listOf(DOC).worker).toBe('new-worker');
  });

  it('every Execute counts a new batch and resets "started"', () => {
    store().add(DOC, change('a', 'shorter'));
    store().markSent(DOC, PID, false);
    store().markStarted(DOC);
    const first = listOf(DOC).batch;
    store().add(DOC, change('b', 'bold'));
    store().markSent(DOC, PID, false);
    expect(listOf(DOC).batch).toBe((first ?? 0) + 1);
    expect(listOf(DOC).started).toBe(false);
  });
});

describe('sentTurnOutcome — when to ask the server', () => {
  const idleDone = { busy: false, status: ProcessStatus.RUNNING, worker_status: WorkerStatus.COMPLETE, queue: null };

  it('a launched worker settles once it reports a final status', () => {
    expect(sentTurnOutcome(idleDone, { fresh: true })).toBe('settle');
    expect(sentTurnOutcome({ ...idleDone, worker_status: WorkerStatus.INTERRUPTED }, { fresh: true })).toBe('settle');
    expect(sentTurnOutcome({ ...idleDone, worker_status: null }, { fresh: true })).toBe('running');
  });

  it('a reused worker idle from its PREVIOUS turn waits until seen busy', () => {
    expect(sentTurnOutcome(idleDone, { fresh: false, started: false })).toBe('running');
    expect(sentTurnOutcome(idleDone, { fresh: false, started: true })).toBe('settle');
  });

  it('busy, or a non-empty queue, is still running', () => {
    expect(sentTurnOutcome({ ...idleDone, busy: true }, { fresh: true })).toBe('running');
    const queue = { enabled: true, entries: [{}] } as unknown as typeof idleDone.queue;
    expect(sentTurnOutcome({ ...idleDone, queue }, { started: true })).toBe('running');
  });

  it('a failed process failed outright', () => {
    expect(sentTurnOutcome({ ...idleDone, status: ProcessStatus.FAILED }, {})).toBe('failed');
  });
});

describe('settleVerdict — the server read decides', () => {
  const idle = { busy: false, status: ProcessStatus.RUNNING, queue: { entries: [] } };
  it('only complete is done', () => {
    expect(settleVerdict({ ...idle, worker_status: WorkerStatus.COMPLETE })).toBe('done');
  });
  it('interrupted, error, or a turn with no verdict ("working" — a model refusal) did not finish', () => {
    expect(settleVerdict({ ...idle, worker_status: WorkerStatus.INTERRUPTED })).toBe('failed');
    expect(settleVerdict({ ...idle, worker_status: WorkerStatus.ERROR })).toBe('failed');
    expect(settleVerdict({ ...idle, worker_status: 'working' })).toBe('failed');
  });
  it('still busy or queued is not settled', () => {
    expect(settleVerdict({ ...idle, busy: true, worker_status: WorkerStatus.COMPLETE })).toBe('running');
    expect(settleVerdict({ ...idle, queue: { entries: [{}] }, worker_status: WorkerStatus.COMPLETE })).toBe('running');
  });
});

describe('buildChangesPrompt', () => {
  it('quotes each change and its instruction, in order, with the doc as context', () => {
    const prompt = buildChangesPrompt(DOC, 'guide', '/proj/docs/guide.md', [
      { id: '1', ...change('Our team is a group', 'Make it shorter') },
      { id: '2', ...change('line one\nline two', 'Bullet list') },
    ]);
    expect(prompt).toContain('Apply these 2 change requests to the document guide.');
    expect(prompt).toContain('The document is the file /proj/docs/guide.md — edit THAT file in place');
    expect(prompt).toContain('1. Where it says:\n   > Our team is a group\n   Change: Make it shorter');
    expect(prompt).toContain('2. Where it says:\n   > line one\n   > line two\n   Change: Bullet list');
    expect(prompt).toContain(DOC.replace('markdown-', 'markdown/'));
  });

  it('says "this change request" for one', () => {
    expect(buildChangesPrompt(DOC, 'guide', '/proj/docs/guide.md', [{ id: '1', ...change('a', 'b') }])).toContain(
      'Apply this change request',
    );
  });
});

describe('resolveChangeMark — where a queued change sits in the doc now', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'inline*' },
      text: { group: 'inline' },
      hardbreak: { group: 'inline', inline: true, leafText: () => '\n' },
    },
  });
  const docOf = (...paras: string[]) =>
    schema.node(
      'doc',
      null,
      paras.map((p) => schema.node('paragraph', null, p ? [schema.text(p)] : [])),
    );
  const mark = (quote: string, from: number, to: number) => ({ id: 'x', quote, from, to, n: 1 });

  it('keeps the stored range while it still holds the quote', () => {
    const doc = docOf('Risks are low.', 'Owner: the team.');
    expect(resolveChangeMark(doc, mark('Risks are low.', 1, 15))).toEqual({ from: 1, to: 15 });
  });

  it('finds the quote again when the text moved (typing above it)', () => {
    const doc = docOf('A new first line.', 'Risks are low.');
    const at = resolveChangeMark(doc, mark('Risks are low.', 1, 15));
    expect(at && doc.textBetween(at.from, at.to)).toBe('Risks are low.');
  });

  it('finds a quote in the middle of a paragraph', () => {
    const doc = docOf('We ship next month if all goes well.');
    const at = resolveChangeMark(doc, mark('next month', 0, 0));
    expect(at && doc.textBetween(at.from, at.to)).toBe('next month');
  });

  it('counts a soft line break (hardbreak leaf) so the mark does not slide by one', () => {
    const para = schema.node('paragraph', null, [
      schema.text('Every URL is loaded'),
      schema.node('hardbreak'),
      schema.text('the same way. This page is the contract;'),
    ]);
    const doc = schema.node('doc', null, [para]);
    const at = resolveChangeMark(doc, mark('contract', 0, 0));
    expect(at && doc.textBetween(at.from, at.to)).toBe('contract');
  });

  it('shows nothing once the quoted text is gone (the worker rewrote it)', () => {
    const doc = docOf('We ship in March.');
    expect(resolveChangeMark(doc, mark('next month', 9, 19))).toBeNull();
  });
});

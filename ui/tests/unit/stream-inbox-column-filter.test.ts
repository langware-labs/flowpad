/**
 * The stream inbox header's column filters (From / Subject / Date) match what a
 * row shows: sender names, subject + preview, and the last-activity time.
 */
import { describe, expect, it } from 'vitest';
import { matchesColumnFilter } from '@src/components/stream-inbox-view/StreamInboxView';
import { DockPointer, type StreamInboxColumns } from '@src/navigation/DockPointer';

const none: StreamInboxColumns = { from: '', subject: '', date: 'any' };
const row = {
  senders: 'Dave Miller, Alice Sh',
  subjectLine: 'shared interview sandbox Extract the Flowpad logs',
  updated: new Date().toISOString(),
};

describe('matchesColumnFilter', () => {
  it('passes everything with no filter', () => {
    expect(matchesColumnFilter(none, row)).toBe(true);
  });

  it('narrows From on any sender, case-insensitively', () => {
    expect(matchesColumnFilter({ ...none, from: 'alice' }, row)).toBe(true);
    expect(matchesColumnFilter({ ...none, from: 'dana' }, row)).toBe(false);
  });

  it('narrows Subject on the subject and the preview', () => {
    expect(matchesColumnFilter({ ...none, subject: 'SANDBOX' }, row)).toBe(true);
    expect(matchesColumnFilter({ ...none, subject: 'flowpad logs' }, row)).toBe(true);
    expect(matchesColumnFilter({ ...none, subject: 'invoice' }, row)).toBe(false);
  });

  it('narrows Date to the window, and a row with no time never passes one', () => {
    const old = { ...row, updated: new Date(Date.now() - 10 * 86_400_000).toISOString() };
    expect(matchesColumnFilter({ ...none, date: 'today' }, row)).toBe(true);
    expect(matchesColumnFilter({ ...none, date: '7d' }, old)).toBe(false);
    expect(matchesColumnFilter({ ...none, date: '30d' }, old)).toBe(true);
    expect(matchesColumnFilter({ ...none, date: 'today' }, { ...row, updated: null })).toBe(false);
  });

  it('requires every engaged column to match', () => {
    expect(matchesColumnFilter({ from: 'dave', subject: 'invoice', date: 'any' }, row)).toBe(false);
  });
});

describe('column filters on the dock URL', () => {
  it('round-trips through the pointer and keeps the page', () => {
    const base = DockPointer.forStreamInbox().withPageBefore('2026-01-01T00:00:00Z');
    const set = base.withStreamInboxColumns({ from: 'ami', subject: '', date: '7d' });
    expect(set.streamInboxColumns).toEqual({ from: 'ami', subject: '', date: '7d' });
    expect(set.pageBefore).toBe(base.pageBefore);
    expect(set.tabHash).toBe(base.tabHash);
    expect(set.withStreamInboxColumns({ from: '', subject: '', date: 'any' }).options).toEqual(base.options);
  });
});

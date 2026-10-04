/**
 * The stream inbox header's column filters (From / Subject / Date) match what a
 * row shows: sender names, subject + preview, and the last-activity time.
 */
import { describe, expect, it } from 'vitest';
import { matchesColumnFilter, type ColumnFilter } from '@src/components/stream-inbox-view/StreamInboxView';

const none: ColumnFilter = { from: '', subject: '', date: 'any' };
const row = {
  senders: 'Tzahi Mazuz, Eran Sh',
  subjectLine: 'shared interview sandbox Extract the Flowpad logs',
  updated: new Date().toISOString(),
};

describe('matchesColumnFilter', () => {
  it('passes everything with no filter', () => {
    expect(matchesColumnFilter(none, row)).toBe(true);
  });

  it('narrows From on any sender, case-insensitively', () => {
    expect(matchesColumnFilter({ ...none, from: 'eran' }, row)).toBe(true);
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
    expect(matchesColumnFilter({ from: 'tzahi', subject: 'invoice', date: 'any' }, row)).toBe(false);
  });
});

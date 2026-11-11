import { describe, expect, it } from 'vitest';
import { continuesGroup, markdownToPlain, withHardBreaks } from '@src/components/conversation/message-markdown';

describe('message markdown', () => {
  it('keeps chat line breaks, but not inside code fences', () => {
    expect(withHardBreaks('a\nb\n\nc')).toBe('a  \nb\n\nc');
    expect(withHardBreaks('x\n```\ny\nz\n```')).toBe('x  \n```\ny\nz\n```');
  });

  it('previews as one plain line', () => {
    expect(markdownToPlain('New task: **Input dashboard** `To do` · [Open in Twenty ↗](https://x/y)\nDue 2026-10-22')).toBe(
      'New task: Input dashboard To do · Open in Twenty ↗ Due 2026-10-22',
    );
    expect(markdownToPlain('file_name_here stays')).toBe('file_name_here stays');
  });

  it('groups the same sender within five minutes', () => {
    const a = { sender_id: 'u1', at: 0 };
    expect(continuesGroup(a, { sender_id: 'u1', at: 60_000 })).toBe(true);
    expect(continuesGroup(a, { sender_id: 'u1', at: 6 * 60_000 })).toBe(false);
    expect(continuesGroup(a, { sender_id: 'u2', at: 1 })).toBe(false);
    expect(continuesGroup(null, { sender_id: 'u1', at: 1 })).toBe(false);
  });
});

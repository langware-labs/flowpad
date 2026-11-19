import { describe, expect, it } from 'vitest';
import { ticketTimeline, timelineKey } from '@src/components/conversation/ticket-timeline';

const at = (key: string, sortAt: number) => ({ key, sortAt });

describe('ticketTimeline — a ticket and its team conversation on one timeline', () => {
  it('gives every message its own row, in time order across both sides', () => {
    const t = ticketTimeline(
      { items: [at('ask', 10), at('answer', 40)], hasOlder: false },
      { items: [at('note', 20), at('reply', 30)], hasOlder: false },
    );
    expect([...t.rowOf]).toEqual([
      [timelineKey('customer', 'ask'), 1],
      [timelineKey('team', 'note'), 2],
      [timelineKey('team', 'reply'), 3],
      [timelineKey('customer', 'answer'), 4],
    ]);
  });

  it('marks each run of team notes once, on the row it starts', () => {
    const t = ticketTimeline(
      { items: [at('ask', 10), at('answer', 40)], hasOlder: false },
      { items: [at('n1', 20), at('n2', 30), at('n3', 50)], hasOlder: false },
    );
    expect(t.teamRuns).toEqual([
      { row: 2, count: 2 },
      { row: 5, count: 1 },
    ]);
  });

  it('holds back what is older than a side that still has messages to load', () => {
    // The customer side has loaded back to 30 only: a note from 20 would sit above messages that came first.
    const t = ticketTimeline(
      { items: [at('late', 30)], hasOlder: true },
      { items: [at('early-note', 20), at('note', 35)], hasOlder: false },
    );
    expect(t.rowOf.has(timelineKey('team', 'early-note'))).toBe(false);
    expect(t.rowOf.get(timelineKey('customer', 'late'))).toBe(1);
    expect(t.rowOf.get(timelineKey('team', 'note'))).toBe(2);
  });

  it('an empty team side leaves the ticket as it is', () => {
    const t = ticketTimeline({ items: [at('ask', 1)], hasOlder: false }, { items: [], hasOlder: false });
    expect(t.rowOf.size).toBe(1);
    expect(t.teamRuns).toEqual([]);
  });

  it('places nothing until both sides have answered, then both at once', () => {
    const ticket = { items: [at('ask', 10), at('answer', 40)], hasOlder: false, loaded: true };
    const early = ticketTimeline(ticket, { items: [], hasOlder: false, loaded: false });
    expect(early.ready).toBe(false);
    expect(early.rowOf.size).toBe(0);
    const both = ticketTimeline(ticket, { items: [at('note', 20)], hasOlder: false, loaded: true });
    expect(both.ready).toBe(true);
    expect(both.rowOf.get(timelineKey('customer', 'answer'))).toBe(3);
  });
});

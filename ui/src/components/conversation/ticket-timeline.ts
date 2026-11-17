/**
 * The one timeline of a help-desk ticket page: the ticket's messages (the customer side) and its team
 * conversation's (the team side), laid out so every row is a moment in time.
 */

export type TicketSide = 'customer' | 'team';

interface TimelineItem {
  key: string;
  sortAt: number;
}

interface SideFeed {
  items: TimelineItem[];
  /** This side has older messages it has not loaded. */
  hasOlder: boolean;
  /** False while this side has not answered yet; absent means it has. */
  loaded?: boolean;
}

interface TicketTimeline {
  /** The grid row (1-based) of each item, by `<side>:<key>`; an item not listed is not drawn yet. */
  rowOf: Map<string, number>;
  /** Where the team wrote while the customer side was quiet: the row their run starts on, and how many notes. */
  teamRuns: { row: number; count: number }[];
  /** Both sides have answered. Until then nothing is placed: drawn early, the side that answers later would
   *  land between the other's rows and push every row after it down. */
  ready: boolean;
}

export const timelineKey = (side: TicketSide, key: string) => `${side}:${key}`;

/**
 * Merge both sides by time. Each item takes a row of its own, so a note sits level with the moment it was
 * written. A side that still has older messages to load hides the other side's items from before its oldest
 * loaded one: drawn, they would sit above messages that really came first.
 */
export function ticketTimeline(customer: SideFeed, team: SideFeed): TicketTimeline {
  if (customer.loaded === false || team.loaded === false) return { rowOf: new Map(), teamRuns: [], ready: false };
  const oldest = (feed: SideFeed) => (feed.hasOlder && feed.items.length ? feed.items[0].sortAt : -Infinity);
  const cut = Math.max(oldest(customer), oldest(team));
  const all = [
    ...customer.items.map((item) => ({ side: 'customer' as const, item })),
    ...team.items.map((item) => ({ side: 'team' as const, item })),
  ]
    .filter(({ item }) => item.sortAt >= cut)
    // Stable: at the same instant the customer's message comes first (it is what a note answers).
    .sort((a, b) => a.item.sortAt - b.item.sortAt);

  const rowOf = new Map<string, number>();
  const teamRuns: { row: number; count: number }[] = [];
  let previous: TicketSide | null = null;
  all.forEach(({ side, item }, index) => {
    const row = index + 1;
    rowOf.set(timelineKey(side, item.key), row);
    if (side === 'team') {
      if (previous === 'team') teamRuns[teamRuns.length - 1].count += 1;
      else teamRuns.push({ row, count: 1 });
    }
    previous = side;
  });
  return { rowOf, teamRuns, ready: true };
}

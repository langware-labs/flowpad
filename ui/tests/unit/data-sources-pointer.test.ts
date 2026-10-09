/**
 * The data sources pointer grammar: the list, the drivers, one driver — and one configured source's page, addressed
 * by its id with an optional tab. A leaf module (the address bar and the view share it), cheap to test directly.
 */
import { describe, expect, it } from 'vitest';

import { dataSourcesPointer, parseDataSourcesPointer } from '@src/components/data-sources/data-sources-pointer';

const ID = '5b112f8f-06d9-46ff-9ff0-d09748a4d512';
const CONV = '5dff9d81-301a-4cfd-9a91-252507893c8c';

describe('data-sources pointer', () => {
  it('round-trips every place', () => {
    for (const route of [
      { section: 'sources' as const },
      { section: 'drivers' as const, driver: null },
      { section: 'drivers' as const, driver: 'flow_telegram' },
      { section: 'channels' as const },
      { section: 'source' as const, id: ID, tab: null },
      { section: 'source' as const, id: ID, tab: 'events' as const },
      { section: 'source' as const, id: ID, tab: 'settings' as const },
      { section: 'source' as const, id: ID, tab: 'messages' as const, conversation: CONV, thread: null },
      { section: 'source' as const, id: ID, tab: 'messages' as const, conversation: CONV, thread: 'th-1' },
    ]) {
      expect(parseDataSourcesPointer(dataSourcesPointer(route))).toEqual(route);
    }
  });

  it('reads a source by its id: a uuid can never be `drivers`, and anything else is the list', () => {
    expect(parseDataSourcesPointer(`${ID}/messages`)).toEqual({ section: 'source', id: ID, tab: 'messages' });
    expect(parseDataSourcesPointer('drivers/whatsapp')).toEqual({ section: 'drivers', driver: 'whatsapp' });
    expect(parseDataSourcesPointer('not-a-source')).toEqual({ section: 'sources' });
    expect(parseDataSourcesPointer(undefined)).toEqual({ section: 'sources' });
  });

  it("keeps a source's conversation on the source's page: <id>/messages/<conversation>[/<thread>]", () => {
    expect(parseDataSourcesPointer(`${ID}/messages/${CONV}`)).toEqual({
      section: 'source',
      id: ID,
      tab: 'messages',
      conversation: CONV,
      thread: null,
    });
    expect(parseDataSourcesPointer(`${ID}/messages/not-a-uuid`)).toEqual({
      section: 'source',
      id: ID,
      tab: 'messages',
    });
  });

  it('lands an unknown tab on the source page with its default tab, not a broken one', () => {
    expect(parseDataSourcesPointer(`${ID}/nope`)).toEqual({ section: 'source', id: ID, tab: null });
  });
});

describe('a file source browsed into a folder', () => {
  const id = '11111111-1111-4111-8111-111111111111';

  it('round-trips the folder under the source, segment by segment', () => {
    const pointer = dataSourcesPointer({ section: 'source', id, tab: null, files: 'co_acme/input' });
    expect(pointer).toBe(`${id}/files/co_acme/input`);
    expect(parseDataSourcesPointer(pointer)).toEqual({ section: 'source', id, tab: null, files: 'co_acme/input' });
  });

  it('is the source top when empty, and never climbs above it', () => {
    expect(dataSourcesPointer({ section: 'source', id, tab: null, files: '' })).toBe(id);
    expect(parseDataSourcesPointer(`${id}/files/../../etc`)).toEqual({ section: 'source', id, tab: null, files: null });
  });
});

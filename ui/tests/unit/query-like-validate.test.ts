/**
 * Client-side ``$LIKE`` validation must mirror the SQL driver's
 * ``field LIKE %value%`` — case-insensitive substring of the FIELD value.
 * It used to build a RegExp from the field and test the query against it
 * (backwards), so live data_op re-validation of $LIKE-watched queries (e.g.
 * the inbox message search) disagreed with what the DB returned, and regex
 * metachars in message text could throw mid-render.
 */
import { describe, expect, it } from 'vitest';
import { QueryFilter } from '@sdk';

const likeText = (needle: string) =>
  QueryFilter.parse({ match: { op: '$LIKE', operands: ['text', needle] } }, 'flow_message');

describe('QueryFilter $LIKE validate', () => {
  it('matches a case-insensitive substring of the field', () => {
    expect(likeText('bugs').validate({ text: 'Big BUGS everywhere' })).toBe(true);
    expect(likeText('bugs').validate({ text: 'all clear' })).toBe(false);
  });

  it('field-contains-query, not query-contains-field', () => {
    // The old reversed impl passed this: RegExp('b').test('bugs') is true,
    // but SQL ``text LIKE '%bugs%'`` on text='b' does NOT match.
    expect(likeText('bugs').validate({ text: 'b' })).toBe(false);
  });

  it('regex metachars in field or query do not throw', () => {
    expect(likeText('c++').validate({ text: 'loves c++ dearly' })).toBe(true);
    expect(likeText('plain').validate({ text: 'broken (regex [text' })).toBe(false);
  });

  it('coerces null/non-string field values instead of throwing', () => {
    expect(likeText('x').validate({ text: null })).toBe(false);
    expect(likeText('object').validate({ text: { legacy: true } })).toBe(true);
  });
});

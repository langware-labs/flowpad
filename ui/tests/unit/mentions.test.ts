import { describe, expect, it } from 'vitest';
import {
  highlightMentions,
  insertMention,
  mentionOptions,
  mentionQueryAt,
  mentionedIn,
  namesOfMentioned,
} from '@src/components/conversation/mentions';

const people = [
  { user_id: 'u-me', name: 'Gadi Tunes', email: 'gadi@x.test' },
  { user_id: 'u-sys', name: 'System', email: null },
  { user_id: 'u-dana', name: 'Dana Levi', email: 'dana@x.test' },
  { user_id: null, name: 'Pending Person', email: 'pending@x.test' },
];

describe('the tag being typed', () => {
  it.each([
    ['@', 1, { start: 0, query: '' }],
    ['hi @sy', 6, { start: 3, query: 'sy' }],
    ['hi @sy', 4, { start: 3, query: '' }],
    ['mail me at a@b', 14, null], // an @ inside a word is not a tag
    ['@sys tem', 8, null], // a space ends it
    ['no tag', 6, null],
  ])('%j at %i', (text, caret, expected) => {
    expect(mentionQueryAt(text, caret)).toEqual(expected);
  });
});

describe('who the list offers', () => {
  it('leaves out the viewer and anyone with no hub id', () => {
    expect(mentionOptions(people, 'u-me', '').map((p) => p.name)).toEqual(['System', 'Dana Levi']);
  });

  it('matches the start of a name, of a word of it, or of the email', () => {
    expect(mentionOptions(people, 'u-me', 'sys').map((p) => p.id)).toEqual(['u-sys']);
    expect(mentionOptions(people, 'u-me', 'levi').map((p) => p.id)).toEqual(['u-dana']);
    expect(mentionOptions(people, null, 'dana@').map((p) => p.id)).toEqual(['u-dana']);
    expect(mentionOptions(people, 'u-me', 'zzz')).toEqual([]);
  });
});

describe('writing and reading the tag', () => {
  it('a pick replaces the typed query with the name and a space', () => {
    expect(insertMention('hi @sy there', 3, 6, 'System')).toEqual({ text: 'hi @System  there', caret: 11 });
  });

  it('the send carries only the picks still written in the text', () => {
    const picks = [
      { id: 'u-sys', name: 'System' },
      { id: 'u-dana', name: 'Dana Levi' },
    ];
    expect(mentionedIn('@System please look', picks)).toEqual(['u-sys']);
    expect(mentionedIn('@Systems is not System', picks)).toEqual([]);
    expect(mentionedIn('@System and @Dana Levi', picks)).toEqual(['u-sys', 'u-dana']);
  });

  it('a tagged name reads in bold, and only where it stands alone', () => {
    expect(highlightMentions('@System check, not x@System', ['System'])).toBe('**@System** check, not x@System');
    expect(highlightMentions('@Dana Levi hi', ['Dana', 'Dana Levi'])).toBe('**@Dana Levi** hi');
  });

  it('names come from the roster, for those it knows', () => {
    expect(namesOfMentioned(['u-sys', 'u-gone'], people)).toEqual(['System']);
  });
});

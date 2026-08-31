import { describe, it, expect } from 'vitest';
import { FSRef } from '@sdk/fs/FSRef';
import { TypeId } from '@sdk';

const ref = (p: string) => new FSRef(p, new TypeId('compute_node', '@local'));

describe('FSRef.resolve', () => {
  it('cancels the filename on one .., landing on a sibling', () => {
    // The DeckViewer case: a deck at x/y/deck.html naming ../t.json. One `..`
    // pops `deck.html`, not the `y` directory — resolution is against the ref's
    // full path, filename included.
    expect(ref('/x/y/deck.html').resolve('../t.json').path).toBe('x/y/t.json');
  });
  it('appends a bare name to the ref path, filename included', () => {
    expect(ref('/x/y/deck.html').resolve('t.json').path).toBe('x/y/deck.html/t.json');
  });
  it('ignores empty and . segments, and walks each ..', () => {
    expect(ref('/a/b/c/d.html').resolve('.././/../e/f.json').path).toBe('a/b/e/f.json');
  });
  it('carries the typeId through, so vpath addresses the target', () => {
    expect(ref('/x/y/deck.html').resolve('../t.json').vpath).toBe('compute_node-@local/x/y/t.json');
  });
});

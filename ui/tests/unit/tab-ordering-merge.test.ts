/**
 * Locks the terminal tab ORDERING invariant (`byTabOrder`). Pure function — no
 * module state. The `Tab` entity now owns durable `tab_order`, so the strip
 * renders directly in that order (the old `mergePreservingOrder` preserve-local-
 * index dance is gone — its index-0-trap concern no longer exists).
 *
 * Entity ids must be valid v4/v5 UUIDs (TypeId enforces the entity-id policy),
 * so each readable label maps to a fixed valid UUID via the fixtures.
 */
import { describe, expect, it } from 'vitest';
import { byTabOrder } from '@src/tabs/useTabs';
import { procTab, shellTab } from '../utils/terminal-tab-fixtures';

describe('byTabOrder', () => {
  it('sorts by ascending tabOrder', () => {
    const sorted = [shellTab('a', 2), shellTab('b', 0), shellTab('c', 1)].sort(byTabOrder);
    expect(sorted.map((t) => t.name)).toEqual(['b', 'c', 'a']);
  });

  it('breaks ties with plain shells before processes', () => {
    const sorted = [procTab('p', 0), shellTab('s', 0)].sort(byTabOrder);
    expect(sorted.map((t) => t.type)).toEqual(['plain', 'claude']);
  });
});

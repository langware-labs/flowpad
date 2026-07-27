// Shared dot-taxonomy grammar — TS side of the cross-language contract.
// The `grammar` section of tests/fixtures/flow_event_contract.json is ALSO
// parsed by tests/unit/test_tag_grammar.py — the two suites pin one
// normalize/pattern/prefix semantics. Change the fixture only with both
// suites in hand.
import { describe, expect, it } from 'vitest';
import {
  isValidTag,
  isValidTagPattern,
  normalizeTag,
  RESERVED_TAG_ROOTS,
  splitNamespace,
  tagAncestors,
  tagIsWithin,
  tagMatches,
  tagPatternProblem,
  tagTree,
  tryTag,
} from '@sdk';
import contract from '../../../tests/fixtures/flow_event_contract.json';

const GRAMMAR = contract.grammar;

describe('tag grammar contract (shared fixture)', () => {
  it('normalize agrees with the Python grammar', () => {
    for (const c of GRAMMAR.normalize_cases) {
      if (c.canonical === null) {
        expect(isValidTag(c.raw), `reject ${JSON.stringify(c.raw)}`).toBe(false);
        expect(() => normalizeTag(c.raw)).toThrow();
      } else {
        expect(normalizeTag(c.raw), `normalize ${JSON.stringify(c.raw)}`).toBe(c.canonical);
        expect(isValidTag(c.raw)).toBe(true);
      }
    }
  });

  it('pattern validation agrees with the Python grammar', () => {
    for (const c of GRAMMAR.pattern_cases) {
      expect(isValidTagPattern(c.pattern), `pattern ${JSON.stringify(c.pattern)}`).toBe(c.valid);
      expect(tagPatternProblem(c.pattern) === null).toBe(c.valid);
    }
  });

  it('hierarchy prefix containment agrees with the Python grammar', () => {
    for (const c of GRAMMAR.within_cases) {
      expect(tagIsWithin(c.tag, c.prefix), `${c.tag} within ${c.prefix}`).toBe(c.within);
    }
  });

  it('namespace splitting agrees with the Python grammar', () => {
    for (const c of GRAMMAR.namespace_cases) {
      expect(splitNamespace(c.tag)).toEqual([c.namespace, c.rest]);
    }
  });

  it('reserved roots agree with the Python entity policy', () => {
    expect([...RESERVED_TAG_ROOTS].sort()).toEqual(GRAMMAR.reserved_roots);
  });
});

describe('tag grammar behavior', () => {
  it('tryTag returns null instead of throwing', () => {
    expect(tryTag('flow.step.done')).toBe('flow.step.done');
    expect(tryTag('not a tag!')).toBeNull();
    expect(tryTag(42)).toBeNull();
  });

  it('ancestors from broadest to narrowest', () => {
    expect(tagAncestors('a.b.c')).toEqual(['a', 'a.b']);
    expect(tagAncestors('a.b.c', true)).toEqual(['a', 'a.b', 'a.b.c']);
    expect(tagAncestors('root')).toEqual([]);
  });

  it('glob vs prefix semantics diverge as designed', () => {
    expect(tagMatches('flow', 'flow.done')).toBe(false);
    expect(tagIsWithin('flow.done', 'flow')).toBe(true);
  });

  it('tagTree derives implicit intermediate nodes', () => {
    const tree = tagTree(['flow.step.done', 'flow.done', 'entity.created']);
    expect(tree['']).toEqual(['entity', 'flow']);
    expect(tree['flow']).toEqual(['flow.done', 'flow.step']);
    expect(tree['flow.step']).toEqual(['flow.step.done']);
  });
});

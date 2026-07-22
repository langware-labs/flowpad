// Shared dot-taxonomy grammar — TS side of the cross-language contract.
// The `grammar` section of tests/fixtures/flow_event_contract.json is ALSO
// parsed by tests/unit/test_topic_grammar.py — the two suites pin one
// normalize/pattern/prefix semantics. Change the fixture only with both
// suites in hand.
import { describe, expect, it } from 'vitest';
import {
  isValidTopic,
  isValidTopicPattern,
  normalizeTopic,
  RESERVED_TOPIC_ROOTS,
  splitNamespace,
  topicAncestors,
  topicIsWithin,
  topicMatches,
  topicPatternProblem,
  topicTree,
  tryTopic,
} from '@sdk';
import contract from '../../../tests/fixtures/flow_event_contract.json';

const GRAMMAR = contract.grammar;

describe('topic grammar contract (shared fixture)', () => {
  it('normalize agrees with the Python grammar', () => {
    for (const c of GRAMMAR.normalize_cases) {
      if (c.canonical === null) {
        expect(isValidTopic(c.raw), `reject ${JSON.stringify(c.raw)}`).toBe(false);
        expect(() => normalizeTopic(c.raw)).toThrow();
      } else {
        expect(normalizeTopic(c.raw), `normalize ${JSON.stringify(c.raw)}`).toBe(c.canonical);
        expect(isValidTopic(c.raw)).toBe(true);
      }
    }
  });

  it('pattern validation agrees with the Python grammar', () => {
    for (const c of GRAMMAR.pattern_cases) {
      expect(isValidTopicPattern(c.pattern), `pattern ${JSON.stringify(c.pattern)}`).toBe(c.valid);
      expect(topicPatternProblem(c.pattern) === null).toBe(c.valid);
    }
  });

  it('hierarchy prefix containment agrees with the Python grammar', () => {
    for (const c of GRAMMAR.within_cases) {
      expect(topicIsWithin(c.topic, c.prefix), `${c.topic} within ${c.prefix}`).toBe(c.within);
    }
  });

  it('namespace splitting agrees with the Python grammar', () => {
    for (const c of GRAMMAR.namespace_cases) {
      expect(splitNamespace(c.topic)).toEqual([c.namespace, c.rest]);
    }
  });

  it('reserved roots agree with the Python entity policy', () => {
    expect([...RESERVED_TOPIC_ROOTS].sort()).toEqual(GRAMMAR.reserved_roots);
  });
});

describe('topic grammar behavior', () => {
  it('tryTopic returns null instead of throwing', () => {
    expect(tryTopic('flow.step.done')).toBe('flow.step.done');
    expect(tryTopic('not a topic!')).toBeNull();
    expect(tryTopic(42)).toBeNull();
  });

  it('ancestors from broadest to narrowest', () => {
    expect(topicAncestors('a.b.c')).toEqual(['a', 'a.b']);
    expect(topicAncestors('a.b.c', true)).toEqual(['a', 'a.b', 'a.b.c']);
    expect(topicAncestors('root')).toEqual([]);
  });

  it('glob vs prefix semantics diverge as designed', () => {
    expect(topicMatches('flow', 'flow.done')).toBe(false);
    expect(topicIsWithin('flow.done', 'flow')).toBe(true);
  });

  it('topicTree derives implicit intermediate nodes', () => {
    const tree = topicTree(['flow.step.done', 'flow.done', 'entity.created']);
    expect(tree['']).toEqual(['entity', 'flow']);
    expect(tree['flow']).toEqual(['flow.done', 'flow.step']);
    expect(tree['flow.step']).toEqual(['flow.step.done']);
  });
});

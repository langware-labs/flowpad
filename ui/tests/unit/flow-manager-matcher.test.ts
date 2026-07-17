/**
 * TS mirror of the FlowManager topic matcher — shared test vectors with
 * tests/unit/test_flow_manager.py (keep the two suites asserting the same
 * cases so the Python and TS matchers can never drift apart).
 */
import { describe, expect, it } from 'vitest';
import {
  isValidTopicName,
  topicAncestors,
  topicMatches,
} from '../../../ts_sdk/src/services/flow-manager';
import { FlowNode, AgenticFlow, Topic } from '../../../ts_sdk/src/entities';

describe('flow-manager matcher (mirror of matcher.py)', () => {
  it('matches prefix at any depth', () => {
    expect(topicMatches('a', 'a')).toBe(true);
    expect(topicMatches('a', 'a.b.c')).toBe(true);
    expect(topicMatches('a.b', 'a.b.c')).toBe(true);
    expect(topicMatches('a.b', 'a.bc')).toBe(false);
    expect(topicMatches('a.b.c', 'a.b')).toBe(false);
  });

  it('computes ancestor chains', () => {
    expect(topicAncestors('a')).toEqual(['a']);
    expect(topicAncestors('report.usage.ready')).toEqual([
      'report',
      'report.usage',
      'report.usage.ready',
    ]);
  });

  it('validates the topic grammar', () => {
    expect(isValidTopicName('report.usage.ready')).toBe(true);
    expect(isValidTopicName('flow-node_1.x')).toBe(true);
    for (const bad of ['', 'a..b', '.a', 'a.', 'A.b', 'a b', 'a.#']) {
      expect(isValidTopicName(bad), bad).toBe(false);
    }
  });
});

describe('flow entities register with the factory', () => {
  it('hydrates via static type ids', () => {
    expect(Topic.type).toBe('topic');
    expect(FlowNode.type).toBe('flow_node');
    expect(AgenticFlow.type).toBe('agentic_flow');
    const t = new Topic({ name: 'a.b.c' });
    expect(t.parentName).toBe('a.b');
    const n = new FlowNode({});
    expect(n.program_kind).toBe('callback');
    expect(n.delivery_mode).toBe('spawn');
  });
});

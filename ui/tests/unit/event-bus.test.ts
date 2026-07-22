import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  EventBus,
  TopicEventBus,
  emitAppTopic,
  onAppTopic,
  topicMatches,
  targetMatches,
  type FlowEvent,
} from '@sdk';

describe('topicMatches — segment-wise glob over the dot path', () => {
  it('matches exact topics', () => {
    expect(topicMatches('app.route.loaded', 'app.route.loaded')).toBe(true);
    expect(topicMatches('app.route.loaded', 'app.route.other')).toBe(false);
  });

  it('trailing * matches any suffix, including deeper paths', () => {
    expect(topicMatches('app.route.*', 'app.route.loaded')).toBe(true);
    expect(topicMatches('app.*', 'app.route.loaded')).toBe(true);
    expect(topicMatches('app.*', 'app.entity.created')).toBe(true);
    expect(topicMatches('*', 'anything.at.all')).toBe(true);
  });

  it('mid-pattern * matches exactly one segment', () => {
    expect(topicMatches('app.*.clicked', 'app.button.clicked')).toBe(true);
    expect(topicMatches('app.*.clicked', 'app.button.deep.clicked')).toBe(false);
  });

  it('never matches partial segments or wrong prefixes', () => {
    expect(topicMatches('app.route', 'app.route.loaded')).toBe(false);
    expect(topicMatches('app.rou', 'app.route')).toBe(false);
    expect(topicMatches('sandbox.*', 'app.route.loaded')).toBe(false);
  });
});

describe('targetMatches — exact or type:* glob', () => {
  it('exact and wildcard forms', () => {
    expect(targetMatches('agent:1234', 'agent:1234')).toBe(true);
    expect(targetMatches('agent:*', 'agent:1234')).toBe(true);
    expect(targetMatches('agent:*', 'artifact:1234')).toBe(false);
    expect(targetMatches('next', 'next')).toBe(true);
    expect(targetMatches('next', 'finish')).toBe(false);
    expect(targetMatches('*', 'anything')).toBe(true);
  });
});

describe('TopicEventBus', () => {
  let bus: TopicEventBus;
  beforeEach(() => {
    bus = new TopicEventBus();
  });

  it('emit/on round-trip delivers the full envelope', () => {
    const seen: FlowEvent[] = [];
    bus.on('app.page.signal', (e) => seen.push(e));
    bus.emit('app.page.signal', 'next', { extra: 1 });

    expect(seen).toHaveLength(1);
    const e = seen[0];
    expect(e.topic).toBe('app.page.signal');
    expect(e.target).toBe('next');
    expect(e.data).toEqual({ extra: 1 });
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(e.timestamp)).not.toBeNaN();
    expect(e.ctx.origin).toBe('app'); // default fill
  });

  it('ctx.origin can be overridden (sandbox tier)', () => {
    const seen: FlowEvent[] = [];
    bus.on('*', (e) => seen.push(e));
    bus.emit('app.page.signal', 'next', {}, { origin: 'sandbox' });
    expect(seen[0].ctx.origin).toBe('sandbox');
  });

  it('target filter gates delivery; no filter means all targets', () => {
    const hits: string[] = [];
    bus.on('app.entity.created', (e) => hits.push(`agents:${e.target}`), { target: 'agent:*' });
    bus.on('app.entity.created', (e) => hits.push(`all:${e.target}`));
    bus.emit('app.entity.created', 'agent:1');
    bus.emit('app.entity.created', 'artifact:2');
    expect(hits).toEqual(['agents:agent:1', 'all:agent:1', 'all:artifact:2']);
  });

  it('unsubscribe stops delivery', () => {
    const handler = vi.fn();
    const unsub = bus.on('a.b', handler);
    bus.emit('a.b', 't');
    unsub();
    bus.emit('a.b', 't');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a throwing handler never blocks emit or its peers', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    bus.on('a.b', () => {
      throw new Error('boom');
    });
    bus.on('a.b', after);
    expect(() => bus.emit('a.b', 't')).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('non-matching topics are not delivered', () => {
    const handler = vi.fn();
    bus.on('app.route.loaded', handler);
    bus.emit('app.entity.created', 'agent:1');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('app. ontology sugar over the singleton', () => {
  beforeEach(() => EventBus.clear());

  it('emitAppTopic/onAppTopic assemble the app. prefix — full topics inside', () => {
    const seen: FlowEvent[] = [];
    const unsub = onAppTopic('route.*', (e) => seen.push(e));
    emitAppTopic('route.loaded', 'dock:home');
    expect(seen).toHaveLength(1);
    expect(seen[0].topic).toBe('app.route.loaded'); // full topic on the wire
    unsub();
  });
});

// ── Cross-language contract (shared golden fixture) ──────────────────────────
// The SAME fixture is parsed by tests/unit/test_topic_bus.py — both buses must
// agree on the envelope shape and every matching case.
import contract from '../../../tests/fixtures/flow_event_contract.json';

describe('FlowEvent contract (shared fixture)', () => {
  it('topic matching agrees with the Python bus', () => {
    for (const c of contract.topic_cases) {
      expect(topicMatches(c.pattern, c.topic), `${c.pattern} vs ${c.topic}`).toBe(c.matches);
    }
  });

  it('target matching agrees with the Python bus', () => {
    for (const c of contract.target_cases) {
      expect(targetMatches(c.pattern, c.target), `${c.pattern} vs ${c.target}`).toBe(c.matches);
    }
  });

  it('the golden envelope is accepted verbatim by deliver()', () => {
    const bus = new TopicEventBus();
    const seen: FlowEvent[] = [];
    bus.on('flow.*', (e) => seen.push(e));
    bus.deliver(contract.envelope as FlowEvent);
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe(contract.envelope.id);
    expect(seen[0].timestamp).toBe(contract.envelope.timestamp);
    expect(seen[0].ctx.actor).toBe('user:u-1');
    expect(seen[0].ctx.origin).toBe('local_server');
  });
});

describe('deliver — relay entry (no re-mint)', () => {
  it('routes a pre-built envelope by pattern + target filter', () => {
    const bus = new TopicEventBus();
    const got: string[] = [];
    bus.on('flow.*', (e) => got.push(`flow:${e.id}`));
    bus.on('*', (e) => got.push(`agent:${e.id}`), { target: 'agent:*' });
    bus.deliver({
      id: 'fixed-id', timestamp: 't', topic: 'flow.done', target: 'agentic_flow:1',
      data: {}, ctx: { origin: 'local_server' },
    });
    expect(got).toEqual(['flow:fixed-id']);
  });

  it('a throwing handler never blocks peers on deliver', () => {
    const bus = new TopicEventBus();
    const got: string[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bus.on('x.*', () => {
      throw new Error('boom');
    });
    bus.on('x.*', (e) => got.push(e.topic));
    bus.deliver({
      id: 'i', timestamp: 't', topic: 'x.y', target: 'a:1', data: {}, ctx: { origin: 'local_server' },
    });
    expect(got).toEqual(['x.y']);
    err.mockRestore();
  });
});

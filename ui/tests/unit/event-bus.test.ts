import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  EventBus,
  TagEventBus,
  emitAppTag,
  onAppTag,
  tagMatches,
  targetMatches,
  type FlowEvent,
} from '@sdk';

describe('tagMatches — segment-wise glob over the dot path', () => {
  it('matches exact tags', () => {
    expect(tagMatches('app.route.loaded', 'app.route.loaded')).toBe(true);
    expect(tagMatches('app.route.loaded', 'app.route.other')).toBe(false);
  });

  it('trailing * matches any suffix, including deeper paths', () => {
    expect(tagMatches('app.route.*', 'app.route.loaded')).toBe(true);
    expect(tagMatches('app.*', 'app.route.loaded')).toBe(true);
    expect(tagMatches('app.*', 'app.entity.created')).toBe(true);
    expect(tagMatches('*', 'anything.at.all')).toBe(true);
  });

  it('mid-pattern * matches exactly one segment', () => {
    expect(tagMatches('app.*.clicked', 'app.button.clicked')).toBe(true);
    expect(tagMatches('app.*.clicked', 'app.button.deep.clicked')).toBe(false);
  });

  it('never matches partial segments or wrong prefixes', () => {
    expect(tagMatches('app.route', 'app.route.loaded')).toBe(false);
    expect(tagMatches('app.rou', 'app.route')).toBe(false);
    expect(tagMatches('sandbox.*', 'app.route.loaded')).toBe(false);
  });
});

describe('targetMatches — exact or trailing-* prefix glob', () => {
  it('exact and wildcard forms', () => {
    expect(targetMatches('agent:1234', 'agent:1234')).toBe(true);
    expect(targetMatches('agent:*', 'agent:1234')).toBe(true);
    expect(targetMatches('agent:*', 'artifact:1234')).toBe(false);
    expect(targetMatches('next', 'next')).toBe(true);
    expect(targetMatches('next', 'finish')).toBe(false);
    expect(targetMatches('*', 'anything')).toBe(true);
  });

  it('trailing * is a prefix glob below the type level too', () => {
    expect(targetMatches('dock:shell/*', 'dock:shell/shell-2')).toBe(true);
    expect(targetMatches('dock:shell/*', 'dock:assets/project-home')).toBe(false);
    expect(targetMatches('dock:shell', 'dock:shell/shell-2')).toBe(false);
  });
});

describe('TagEventBus', () => {
  let bus: TagEventBus;
  beforeEach(() => {
    bus = new TagEventBus();
  });

  it('emit/on round-trip delivers the full envelope', () => {
    const seen: FlowEvent[] = [];
    bus.on('app.page.signal', (e) => seen.push(e));
    bus.emit('app.page.signal', 'next', { extra: 1 });

    expect(seen).toHaveLength(1);
    const e = seen[0];
    expect(e.tag).toBe('app.page.signal');
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

  it('non-matching tags are not delivered', () => {
    const handler = vi.fn();
    bus.on('app.route.loaded', handler);
    bus.emit('app.entity.created', 'agent:1');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('app. ontology sugar over the singleton', () => {
  beforeEach(() => EventBus.clear());

  it('emitAppTag/onAppTag assemble the app. prefix — full tags inside', () => {
    const seen: FlowEvent[] = [];
    const unsub = onAppTag('route.*', (e) => seen.push(e));
    emitAppTag('route.loaded', 'dock:home');
    expect(seen).toHaveLength(1);
    expect(seen[0].tag).toBe('app.route.loaded'); // full tag on the wire
    unsub();
  });
});

// ── Cross-language contract (shared golden fixture) ──────────────────────────
// The SAME fixture is parsed by tests/unit/test_tag_bus.py — both buses must
// agree on the envelope shape and every matching case.
import contract from '../../../tests/fixtures/flow_event_contract.json';

describe('FlowEvent contract (shared fixture)', () => {
  it('tag matching agrees with the Python bus', () => {
    for (const c of contract.tag_cases) {
      expect(tagMatches(c.pattern, c.tag), `${c.pattern} vs ${c.tag}`).toBe(c.matches);
    }
  });

  it('target matching agrees with the Python bus', () => {
    for (const c of contract.target_cases) {
      expect(targetMatches(c.pattern, c.target), `${c.pattern} vs ${c.target}`).toBe(c.matches);
    }
  });

  it('the golden envelope is accepted verbatim by deliver()', () => {
    const bus = new TagEventBus();
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
    const bus = new TagEventBus();
    const got: string[] = [];
    bus.on('flow.*', (e) => got.push(`flow:${e.id}`));
    bus.on('*', (e) => got.push(`agent:${e.id}`), { target: 'agent:*' });
    bus.deliver({
      id: 'fixed-id', timestamp: 't', tag: 'flow.done', target: 'agentic_flow:1',
      data: {}, ctx: { origin: 'local_server' },
    });
    expect(got).toEqual(['flow:fixed-id']);
  });

  it('a throwing handler never blocks peers on deliver', () => {
    const bus = new TagEventBus();
    const got: string[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bus.on('x.*', () => {
      throw new Error('boom');
    });
    bus.on('x.*', (e) => got.push(e.tag));
    bus.deliver({
      id: 'i', timestamp: 't', tag: 'x.y', target: 'a:1', data: {}, ctx: { origin: 'local_server' },
    });
    expect(got).toEqual(['x.y']);
    err.mockRestore();
  });
});

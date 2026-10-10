import { describe, expect, it } from 'vitest';
import type { FlowMessage } from '@sdk';
import { LifecycleState, lifecyclesOf, onlyWithSessions, type Lifecycle } from '@src/components/conversation/message-lifecycle';

const inbound = (id: string, key = `wamid.${id}`) =>
  ({ id, origin: { kind: 'whatsapp', namespace: 'n', key, url: null }, sender: { kind: 'external', channel: 'whatsapp', address: '1' } }) as unknown as FlowMessage;
const answer = (id: string, replyTo: string | null = null) =>
  ({ id, reply_to_id: replyTo, sender: { kind: 'agent', id: 'flow' } }) as unknown as FlowMessage;

const states = (m: Map<string, Lifecycle>) => Object.fromEntries([...m].map(([k, v]) => [k, v.state]));

describe('lifecyclesOf', () => {
  it('an incoming message nobody picked up reads Arrived', () => {
    expect(states(lifecyclesOf([inbound('a')], new Set()))).toEqual({ a: LifecycleState.Arrived });
  });

  it('is Handling once an agent here took it, by its origin key', () => {
    expect(states(lifecyclesOf([inbound('a')], new Set(['wamid.a'])))).toEqual({ a: LifecycleState.Handling });
  });

  it('an answer replies to what it quotes and to everything still open before it', () => {
    const got = lifecyclesOf([inbound('a'), inbound('b'), answer('r', 'b'), inbound('c')], new Set(['wamid.b']));
    expect(states(got)).toEqual({ a: LifecycleState.Replied, b: LifecycleState.Replied, c: LifecycleState.Arrived });
  });

  it('on a channel nobody here answers, only a message an automation took gets a line', () => {
    const sessions = new Map([['b', { id: 'p', status: 'running' } as never]]);
    const got = onlyWithSessions(lifecyclesOf([inbound('a'), inbound('b')], new Set(), sessions), sessions);
    expect(states(got)).toEqual({ b: LifecycleState.Handling });
  });

  it('hands every bubble the same object per state, so a recomputed feed re-renders nothing', () => {
    const one = lifecyclesOf([inbound('a')], new Set());
    const two = lifecyclesOf([inbound('a')], new Set());
    expect(one.get('a')).toBe(two.get('a'));
  });
});

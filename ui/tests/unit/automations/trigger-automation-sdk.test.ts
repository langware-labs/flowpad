/**
 * The TS SDK is the only door the Automations screen has to the backend, so
 * each `Trigger` method must build exactly the action the Python side declares
 * (flow_sdk/builtin/trigger.py): name, entity, method, query and body.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionInfo, dataManager, isMessagePattern, messageRuleFields, parseTarget, Trigger } from '@sdk';

function capture(answer: unknown = {}) {
  const calls: ActionInfo[] = [];
  vi.spyOn(dataManager, 'callAction').mockImplementation((action: ActionInfo) => {
    calls.push(action);
    return Promise.resolve(answer as never);
  });
  return calls;
}

const ID = '550e8400-e29b-41d4-a716-446655440000';

afterEach(() => vi.restoreAllMocks());

describe('Trigger automation methods', () => {
  it.each([
    ['overview', () => Trigger.overview(), 'GET', '/graph/trigger/overview'],
    ['started_last_hour', () => Trigger.startedLastHour(), 'GET', '/graph/trigger/started_last_hour'],
    [
      'runs',
      () => Trigger.runs({ triggerId: 't1', status: 'failed', includeTests: false, limit: 50 }),
      'GET',
      '/graph/trigger/runs',
    ],
    ['run', () => Trigger.run('r1'), 'GET', '/graph/trigger/run'],
    [
      'next_runs',
      () => Trigger.nextRuns({ expr: '0 9 * * 1-5', timezone: 'UTC' }, 3),
      'GET',
      '/graph/trigger/next_runs',
    ],
    ['bus_map', () => Trigger.busMap(), 'GET', '/graph/trigger/bus_map'],
    ['check_spec', () => Trigger.checkSpec({ trigger_type: 'tag' }), 'POST', '/graph/trigger/check_spec'],
    ['decide_spec', () => Trigger.decideSpec({ trigger_type: 'tag' }, { text: 'x' }), 'POST', '/graph/trigger/decide_spec'],
    [
      'match_pattern',
      () => Trigger.matchPattern('task.*', { tag: 'task.x', target: 't:1' }),
      'POST',
      '/graph/trigger/match_pattern',
    ],
    ['recent_events', () => Trigger.recentEvents('task.*'), 'GET', '/graph/trigger/recent_events'],
    ['create', () => Trigger.createAutomation({ name: 'n', trigger_type: 'tag' }), 'POST', '/graph/trigger/create'],
    [
      'create',
      () => Trigger.onMessage({ catch: 'asks for a refund', sources: ['ds-1'], agent: 'ag-1', prompt: 'Go' }),
      'POST',
      '/graph/trigger/create',
    ],
  ] as const)('%s', async (name, call, method, path) => {
    const calls = capture([]);
    await call();
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe(name);
    expect(calls[0].method).toBe(method);
    expect(calls[0].actionUrl.split('?')[0]).toBe(path);
  });

  it.each([
    ['test', () => Trigger.runOnce(ID, { tag: 'a.b', target: 'x:1' }), 'POST'],
    ['decide_on', () => Trigger.decideOn(ID, { text: 'refund me' }), 'POST'],
    ['decide_on_recent', () => Trigger.decideOnRecent(ID, { limit: 5 }), 'GET'],
    ['check', () => Trigger.check(ID), 'POST'],
    ['samples', () => Trigger.samples(ID), 'GET'],
    ['update', () => Trigger.setEnabled(ID, false), 'PATCH'],
    ['delete', () => Trigger.remove(ID), 'DELETE'],
    ['trigger-content', () => Trigger.getCode(ID), 'GET'],
    ['log', () => Trigger.log(ID), 'GET'],
  ] as const)('%s is an action on one automation', async (name, call, method) => {
    const calls = capture({});
    await call();
    expect(calls[0].name).toBe(name);
    expect(calls[0].method).toBe(method);
    expect(calls[0].actionUrl.split('?')[0]).toBe(`/graph/trigger/${ID}/${name}`);
  });

  it('runs sends only the filters given', async () => {
    const calls = capture([]);
    await Trigger.runs({ triggerId: 't1', includeTests: false });
    await Trigger.runs({ triggerId: 't1', includeDeclined: true });
    expect(calls[0].queryParameters).toEqual({ trigger_id: 't1', include_tests: 'false' });
    expect(calls[1].queryParameters).toEqual({ trigger_id: 't1', include_declined: 'true' });
  });

  it('onMessage sends the rule the Python builder makes: the pattern, the scope, a sentence gate, the sugar', async () => {
    const calls = capture({ id: ID, name: 'n' });
    await Trigger.onMessage({ catch: 'asks for a refund', sources: ['ds-1', 'data_source:ds-2'], agent: 'agent-ag-1', prompt: 'Go' });
    expect(calls[0].bodyParameters).toEqual({
      name: 'Asks for a refund → an agent',
      trigger_type: 'tag',
      tag_pattern: 'stream_inbox.*.message.projected',
      tag_scope: ['data_source:ds-1', 'data_source:ds-2'],
      gate: { sentence: 'asks for a refund' },
      then: { run_agent: { agent: 'agent-ag-1', prompt: 'Go' } },
      enabled: true,
      project_id: null,
    });
  });

  it('decideOn asks about a message by id, or about text', async () => {
    const calls = capture({});
    await Trigger.decideOn(ID, { messageId: 'm-1' });
    await Trigger.decideOn(ID, { text: 'hi' });
    expect(calls[0].bodyParameters).toEqual({ message_id: 'm-1' });
    expect(calls[1].bodyParameters).toEqual({ text: 'hi' });
  });

  it('run once on a message carries its id', async () => {
    const calls = capture({});
    await Trigger.runOnce(ID, null, { messageId: 'm-1' });
    expect(calls[0].bodyParameters).toEqual({ message_id: 'm-1' });
  });

  it('run once carries the picked event, and nothing when none is picked', async () => {
    const calls = capture({});
    await Trigger.runOnce(ID, { tag: 'a.b', target: 'x:1', data: { k: 1 } });
    await Trigger.runOnce(ID);
    expect(calls[0].bodyParameters).toEqual({ event: { tag: 'a.b', target: 'x:1', data: { k: 1 } } });
    expect(calls[1].bodyParameters).toEqual({});
  });

  it('setEnabled patches only enabled', async () => {
    const calls = capture({});
    await Trigger.setEnabled(ID, true);
    expect(calls[0].bodyParameters).toEqual({ enabled: true });
  });

  it('overview asks for inactive copies only when told to', async () => {
    const calls = capture([]);
    await Trigger.overview();
    await Trigger.overview({ includeInactive: true });
    expect(calls[0].queryParameters).toEqual({});
    expect(calls[1].queryParameters).toEqual({ include_inactive: 'true' });
  });

  it('a message pattern is every channel\'s or one channel\'s, and nothing else', () => {
    expect(isMessagePattern('stream_inbox.*.message.projected')).toBe(true);
    expect(isMessagePattern('stream_inbox.gmail.message.projected')).toBe(true);
    expect(isMessagePattern('stream_inbox.gmail.message.status')).toBe(false);
    expect(isMessagePattern('stream_inbox.a.b.message.projected')).toBe(false);
    expect(isMessagePattern('app.ready')).toBe(false);
    expect(isMessagePattern(null)).toBe(false);
  });

  it('a message rule scopes by colon targets, whichever way the source was named', () => {
    const fields = messageRuleFields({ catch: 'x', sources: ['ds-1', 'data_source:ds-2'], agent: 'a', prompt: 'p' });
    expect(fields.tag_scope).toEqual(['data_source:ds-1', 'data_source:ds-2']);
    expect(parseTarget('data_source:ds-1')).toEqual(['data_source', 'ds-1']);
    expect(parseTarget('ds-1')).toEqual([null, null]);
    expect(parseTarget(null)).toEqual([null, null]);
  });
});

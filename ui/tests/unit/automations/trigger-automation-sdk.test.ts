/**
 * The TS SDK is the only door the Automations screen has to the backend, so
 * each `Trigger` method must build exactly the action the Python side declares
 * (flow_sdk/builtin/trigger.py): name, entity, method, query and body.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionInfo, dataManager, Trigger } from '@sdk';

function capture(answer: unknown = {}) {
  const calls: ActionInfo[] = [];
  vi.spyOn(dataManager, 'callAction').mockImplementation(async (action: ActionInfo) => {
    calls.push(action);
    return answer as never;
  });
  return calls;
}

const ID = '550e8400-e29b-41d4-a716-446655440000';

afterEach(() => vi.restoreAllMocks());

describe('Trigger automation methods', () => {
  it.each([
    ['overview', () => Trigger.overview(), 'GET', '/graph/trigger/overview'],
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
    [
      'match_pattern',
      () => Trigger.matchPattern('task.*', { tag: 'task.x', target: 't:1' }),
      'POST',
      '/graph/trigger/match_pattern',
    ],
    ['recent_events', () => Trigger.recentEvents('task.*'), 'GET', '/graph/trigger/recent_events'],
    ['create', () => Trigger.createAutomation({ name: 'n', trigger_type: 'tag' }), 'POST', '/graph/trigger/create'],
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
    expect(calls[0].queryParameters).toEqual({ trigger_id: 't1', include_tests: 'false' });
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
});

/**
 * `docs/snippets/stream-inbox-automations.md` §9 — the TypeScript fence, run as written against the
 * SDK with `dataManager.callAction` spied: every verb builds exactly the action the Python side
 * declares (name, entity, method, query, body).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionInfo, dataManager, Trigger } from '@sdk';

import { runTsFence, snippetDoc, tsFenceUnder } from '../utils/ts-snippets';

const RULE_ID = '7a1e2a40-0000-4000-8000-000000000001';

afterEach(() => vi.restoreAllMocks());

describe('stream-inbox-automations.md §9', () => {
  it('runs as written and reaches the backend only through Trigger actions', async () => {
    const calls: ActionInfo[] = [];
    const answers: Record<string, unknown> = {
      create: { id: RULE_ID, name: 'Refunds', trigger_type: 'tag' },
      decide_on: { met: true, confidence: 0.93, reason: 'asks for a refund', answers: {} },
      decide_on_recent: [{ state: { text: 'x' }, verdict: { met: false }, decided_at: null }],
      overview: [{ id: RULE_ID, started_last_hour: 1 }],
      started_last_hour: 1,
    };
    vi.spyOn(dataManager, 'callAction').mockImplementation((action: ActionInfo) => {
      calls.push(action);
      return Promise.resolve((answers[action.name] ?? []) as never);
    });
    const ns = await runTsFence(tsFenceUnder(snippetDoc('stream-inbox-automations.md'), '9.'), {
      Trigger,
      workMail: { id: 'ds-1' },
      billing: { id: 'ag-1' },
      prompt: 'Draft the reply.',
    });

    expect(ns.rule).toBeInstanceOf(Trigger);
    expect(ns.verdict).toMatchObject({ met: true, confidence: 0.93 });
    expect(ns.tries).toHaveLength(1);
    expect(ns.rows[0].started_last_hour).toBe(1);
    expect(ns.started).toBe(1);

    expect(calls.map((c) => [c.name, c.method, c.actionUrl.split('?')[0]])).toEqual([
      ['create', 'POST', '/graph/trigger/create'],
      ['decide_on', 'POST', `/graph/trigger/${RULE_ID}/decide_on`],
      ['decide_on_recent', 'GET', `/graph/trigger/${RULE_ID}/decide_on_recent`],
      ['overview', 'GET', '/graph/trigger/overview'],
      ['started_last_hour', 'GET', '/graph/trigger/started_last_hour'],
    ]);
    const created = calls[0].bodyParameters as Record<string, unknown>;
    expect(created.tag_pattern).toBe('stream_inbox.*.message.projected');
    expect(created.tag_scope).toEqual(['data_source:ds-1']);
    expect(created.gate).toEqual({ sentence: 'asks for a refund or disputes a charge' });
    expect(created.then).toEqual({ run_agent: { agent: 'agent-ag-1', prompt: 'Draft the reply.' } });
    expect(calls[1].bodyParameters).toEqual({ text: 'I was billed twice…' });
    expect(calls[2].queryParameters).toEqual({ limit: '20' });
  });
});

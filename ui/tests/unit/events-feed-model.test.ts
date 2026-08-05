/**
 * The Events feed's merge: bus envelopes + rule fires → one list.
 *
 * Neither of the screens this replaced had a single test. The logic worth
 * pinning is the join — a fire nests under the envelope that caused it, and a
 * fire whose cause is absent must still be shown.
 */
import { describe, expect, it } from 'vitest';
import type { FlowEvent } from '@sdk/tags/EventBus';
import type { TriggerLogEntry } from '@src/hooks/useTriggerLog';
import { buildFeed, eventInScope, fireStatus } from '@src/components/events/feed-model';

function ev(id: string, tag: string, at: string, extra: Partial<FlowEvent> = {}): FlowEvent {
  return {
    id,
    tag,
    target: 'usage_report:r-1',
    timestamp: at,
    data: {},
    ctx: { origin: 'local_server', scope: [] },
    ...extra,
  } as FlowEvent;
}

function fire(id: string, at: string, extra: Partial<TriggerLogEntry> = {}): TriggerLogEntry {
  return {
    id,
    ts: at,
    hook_event: 'tag_fire',
    trigger: true,
    reason: '',
    is_test: false,
    rule_name: 'on usage report',
    actions: [],
    ...extra,
  } as TriggerLogEntry;
}

describe('fireStatus', () => {
  it('reads the outcome from trigger + reason_code', () => {
    expect(fireStatus(fire('a', '2026-08-04T10:00:00Z'))).toBe('fired');
    expect(
      fireStatus(fire('b', '2026-08-04T10:00:00Z', { trigger: false, reason_code: 'confirm_failed' })),
    ).toBe('filtered');
    expect(
      fireStatus(fire('c', '2026-08-04T10:00:00Z', { trigger: false, reason_code: 'storm' })),
    ).toBe('suppressed');
  });

  it('degrades a declined row with no reason_code to suppressed, not fired', () => {
    // Rows written before the emitters existed carry no reason_code. Reporting
    // them as `fired` would be the one genuinely misleading answer.
    expect(fireStatus(fire('d', '2026-08-04T10:00:00Z', { trigger: false }))).toBe('suppressed');
  });
});

describe('buildFeed', () => {
  it('nests a fire under the envelope that caused it', () => {
    const cause = ev('E1', 'entity.created', '2026-08-04T10:00:00.000Z');
    const rows = buildFeed(
      [cause],
      [fire('F1', '2026-08-04T10:00:01.000Z', { cause_event_id: 'E1' })],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('event');
    expect(rows[0].children).toHaveLength(1);
    expect(rows[0].children[0].kind).toBe('fire');
    // The collapsed parent already answers "did anything happen because of this".
    expect(rows[0].status).toBe('fired');
    expect(rows[0].ruleName).toBe('on usage report');
  });

  it('keeps a fire whose cause is absent as a top-level row', () => {
    // The common case: `entity.*` is not forwarded and the ring only goes back
    // so far. Dropping the fire would be the worst failure mode for a screen
    // whose whole job is showing fires.
    const rows = buildFeed([], [fire('F1', '2026-08-04T10:00:01.000Z', { cause_event_id: 'GONE' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('fire');
  });

  it('keeps a fire with no cause at all (schedule, fsop, hook)', () => {
    const rows = buildFeed([], [fire('F1', '2026-08-04T10:00:01.000Z')]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('fire');
  });

  it('sorts newest first across both sources', () => {
    const rows = buildFeed(
      [ev('E1', 'a.one', '2026-08-04T10:00:00.000Z'), ev('E2', 'a.two', '2026-08-04T10:00:05.000Z')],
      [fire('F1', '2026-08-04T10:00:03.000Z')],
    );
    expect(rows.map((r) => r.key)).toEqual(['e:E2', 'f:F1', 'e:E1']);
  });

  it('does not double-count a nested fire as a top-level row', () => {
    const rows = buildFeed(
      [ev('E1', 'entity.created', '2026-08-04T10:00:00.000Z')],
      [
        fire('F1', '2026-08-04T10:00:01.000Z', { cause_event_id: 'E1' }),
        fire('F2', '2026-08-04T10:00:02.000Z'),
      ],
    );
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.kind === 'fire')).toHaveLength(1);
  });
});

describe('eventInScope', () => {
  const project = { mode: 'project', activeProjectId: 'p-1' } as const;

  it('keeps an instance-level envelope while a project is selected', () => {
    // The regression this exists for: a Slack source really did ingest 6
    // messages, `ingest.slack.sync.completed` really was on the bus and in the
    // server ring — and the feed rendered an empty list, because an envelope
    // with no `project:` in its chain fell through to "user-scope only", which
    // is false for `mode: 'project'`. A data source belongs to the instance;
    // there is no project it could have carried instead.
    const event = ev('e1', 'ingest.slack.sync.completed', '2026-08-05T10:00:00Z');
    expect(eventInScope(event, project, 'p-1')).toBe(true);
  });

  it('keeps a matching project envelope and drops another project’s', () => {
    const mine = ev('e2', 'graph_workflow.started', '2026-08-05T10:00:00Z', {
      ctx: { origin: 'local_server', scope: ['project:p-1'] },
    });
    const theirs = ev('e3', 'graph_workflow.started', '2026-08-05T10:00:00Z', {
      ctx: { origin: 'local_server', scope: ['project:p-2'] },
    });

    expect(eventInScope(mine, project, 'p-1')).toBe(true);
    expect(eventInScope(theirs, project, 'p-1')).toBe(false);
  });

  it('keeps everything under an all scope', () => {
    const theirs = ev('e4', 'graph_workflow.started', '2026-08-05T10:00:00Z', {
      ctx: { origin: 'local_server', scope: ['project:p-2'] },
    });
    expect(eventInScope(theirs, { mode: 'all' }, 'p-1')).toBe(true);
  });
});

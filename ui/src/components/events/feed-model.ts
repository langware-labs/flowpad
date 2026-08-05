/**
 * The feed's data model — two sources, one list.
 *
 * A row is either a bus ENVELOPE (live, via the WS tag bridge + the server's
 * recent-events ring) or a rule FIRE (durable, via the trigger-log REST poll).
 * They are separate sources because `trigger.*` is deliberately not forwarded to
 * the app (the reason, and the condition that would change it, are stated once
 * in `tests/unit/test_trigger_tags.py`) and because the bus keeps no history —
 * the log is what survives a backend restart.
 *
 * This module is deliberately free of React: the predicates that decide what the
 * feed contains are the part worth unit-testing, and they used to be split
 * across a component file and the view.
 *
 * `cause_event_id` is what makes the two halves one story: a fire points at the
 * envelope that caused it, so the feed can nest `entity.created → fired "on
 * usage report" → the run it started`.
 */
import type { FlowEvent } from '@sdk/tags/EventBus';
import type { ITrigger } from '@sdk';
import {
  isAllScope,
  projectIdInScope,
  scopeIncludesUser,
  scopeProjectIds,
  type ScopeFilter,
} from '@src/lib/scope-filter';
import type { TriggerLogEntry } from '@src/hooks/useTriggerLog';

/**
 * Does this rule belong in the current scope?
 *
 * System rules ride `includeSystem` rather than the ScopeFilter because the
 * filter's shape is `{mode, user, projects}` and `system` is not a record scope
 * at all — it is a Trigger-entity field value. Both the rules list and the feed
 * must use THIS predicate or the two panes disagree about what exists.
 */
export function ruleInScope(
  t: Pick<ITrigger, 'scope' | 'project_id'>,
  scope: ScopeFilter,
  includeSystem: boolean,
): boolean {
  const s = t.scope || 'user';
  if (s === 'system') return includeSystem;
  if (isAllScope(scope)) return true;
  if (s === 'project') {
    // Project-scoped rules without a project_id are unreachable via the chip
    // picker — hide them rather than leaking into the list.
    const pid = t.project_id ?? '';
    return pid !== '' && scopeProjectIds(scope).includes(pid);
  }
  return scopeIncludesUser(scope);
}

/**
 * Does this envelope belong in the current scope? An event carrying a
 * `project:<id>` in its containment chain belongs to that project; one carrying
 * none is instance-level (node.*, agent.status, ingest) and rides the user
 * bucket, so selecting a project never hides the machine's own activity.
 */
export function eventInScope(
  event: FlowEvent,
  scope: ScopeFilter,
  currentProjectId: string | null,
): boolean {
  const projectTarget = (event.ctx?.scope ?? []).find((s) => s.startsWith('project:'));
  // No project in the chain ⇒ instance-level, and instance-level is ALWAYS
  // visible. It cannot go through `projectIdInScope`, whose "no project ⇒
  // user-scope only" rule returns false for `mode: 'project'` — and since the
  // dock defaults to the active project, that hid every `ingest.*`,
  // `agent.status` and `node.*` envelope the moment a project was selected.
  // A data source is a property of the instance; there is no project it could
  // have carried instead.
  if (!projectTarget) return true;
  return projectIdInScope(projectTarget.slice('project:'.length), scope, currentProjectId);
}

/** What happened to a rule when an event reached it. */
export type FireStatus = 'fired' | 'filtered' | 'suppressed' | 'failed' | 'none';

export interface EventRow {
  key: string;
  /** Sort key — epoch ms. */
  at: number;
  kind: 'event' | 'fire';
  /** Bus envelope, when kind === 'event'. */
  event?: FlowEvent;
  /** Trigger-log row, when kind === 'fire'. */
  fire?: TriggerLogEntry;
  /** Fires whose cause is present in this list get nested under it. */
  children: EventRow[];
  status: FireStatus;
  /** Rule name for a fire; empty for a bare envelope. */
  ruleName: string;
  /** The tag (envelope) or a synthesised label (fire). */
  label: string;
  /** Subject — envelope target, or the rule's subject for a fire. */
  subject: string;
  /** One-line gist, already humanised. */
  gist: string;
}

const MS = (iso: string | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/**
 * A fire's status. `trigger` false means the rule declined; `reason_code` says
 * why. Rows written before the emitters existed carry no reason_code, so a
 * declined row without one degrades to `suppressed` rather than lying about it.
 */
export function fireStatus(entry: TriggerLogEntry): FireStatus {
  if (entry.trigger) return 'fired';
  if (entry.reason_code === 'confirm_failed') return 'filtered';
  return 'suppressed';
}

/** Human label for a status pill. */
export const STATUS_LABEL: Record<FireStatus, string> = {
  fired: 'fired',
  filtered: 'filtered',
  suppressed: 'suppressed',
  failed: 'failed',
  none: 'no match',
};

/**
 * Tailwind classes per status. Semantic colour only — deliberately not the
 * accent, so "needs attention" reads before anything decorative does.
 */
export const STATUS_CLASS: Record<FireStatus, string> = {
  fired: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  filtered: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  suppressed: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  failed: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
  none: 'bg-muted text-muted-foreground',
};

/** A one-line gist so an envelope row says something unexpanded. */
function summariseEvent(event: FlowEvent): string {
  const data: Record<string, unknown> = event.data ?? {};
  const changed = data.changed_ids;
  if (Array.isArray(changed)) {
    const counts = ['created', 'updated', 'unchanged']
      .map((k) => (typeof data[k] === 'number' ? `${data[k]} ${k}` : null))
      .filter(Boolean)
      .join(', ');
    return counts || `${changed.length} changed`;
  }
  for (const key of ['phase', 'kind', 'status', 'event', 'node_id']) {
    const value = data[key];
    if (typeof value === 'string' && value) return `${key}=${value}`;
  }
  return '';
}

/** A fire's subject: the file that changed, the cause's target, or the rule. */
function fireSubject(entry: TriggerLogEntry): string {
  if (entry.cause_target) return entry.cause_target;
  if (entry.changed_path) return entry.changed_path;
  return entry.rule_name || '';
}

function fireGist(entry: TriggerLogEntry): string {
  const total = entry.changes_total ?? 0;
  if (total > 1) return `${total} file events`;
  if (entry.agentic_process_id) return 'started a process';
  // `reason` for a single file change is "File modified: <path>", which just
  // restates the subject column. Show the verb alone.
  if (entry.change_type) return entry.change_type;
  return entry.reason_code || '';
}

function rowForEvent(event: FlowEvent): EventRow {
  return {
    key: `e:${event.id}`,
    at: MS(event.timestamp),
    kind: 'event',
    event,
    children: [],
    status: 'none',
    ruleName: '',
    label: event.tag,
    subject: event.target ?? '',
    gist: summariseEvent(event),
  };
}

function rowForFire(entry: TriggerLogEntry): EventRow {
  const status = fireStatus(entry);
  return {
    key: `f:${entry.id}`,
    at: MS(entry.ts),
    kind: 'fire',
    fire: entry,
    children: [],
    status,
    ruleName: entry.rule_name || '',
    label: entry.cause_tag || entry.hook_event || 'fire',
    subject: fireSubject(entry),
    gist: fireGist(entry),
  };
}

/**
 * Merge envelopes and fires into one newest-first list, nesting each fire under
 * its causing envelope when that envelope is present.
 *
 * A fire whose cause is NOT in the list (the common case — `entity.*` is not
 * forwarded, and the ring only goes back so far) stays a top-level row rather
 * than being dropped. Losing a fire because its cause aged out would be the
 * worst possible failure mode for a screen whose whole job is showing fires.
 */
export function buildFeed(events: FlowEvent[], fires: TriggerLogEntry[]): EventRow[] {
  const byEventId = new Map<string, EventRow>();
  const rows: EventRow[] = [];

  for (const event of events) {
    const row = rowForEvent(event);
    byEventId.set(event.id, row);
    rows.push(row);
  }

  for (const entry of fires) {
    const row = rowForFire(entry);
    const parent = entry.cause_event_id ? byEventId.get(entry.cause_event_id) : undefined;
    if (parent) {
      parent.children.push(row);
      // The parent inherits its child's outcome so the collapsed row already
      // answers "did anything happen because of this?".
      parent.status = row.status;
      parent.ruleName = row.ruleName;
    } else {
      rows.push(row);
    }
  }

  return rows.sort((a, b) => b.at - a.at);
}

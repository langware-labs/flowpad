import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { QueryRequest } from '../FlowSync/query';
import { IEntity, EntityMerge } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import { HttpMethod } from '../models/ApiUrl';
import { TypeId } from '../models/TypeId';
import { parseTarget, targetOf } from '../tags/EventBus';
import { HookEventData, TriggerAction, RelationshipSubAction } from './agent-hook-enums';
import { AgentHook } from './agent-hook';
import type {
  BusMap,
  AutomationCheck,
  AutomationRun,
  AutomationSample,
  AutomationSummary,
  PatternMatch,
  AutomationTestEvent,
  NextRuns,
  RunOnceStarted,
  RunsQuery,
  TryRow,
} from './automation-types';
import type { DecisionVerdict } from '../models/ReturnedValue';

/** One raw trigger-log row (`fs_store/operations/trigger_log.py`). The Automations screen reads runs instead. */
export interface TriggerLogRow {
  id: string;
  ts: string;
  hook_event: string;
  trigger: boolean;
  reason: string;
  is_test: boolean;
  rule_name: string;
  trigger_id?: string | null;
  trigger_type?: string | null;
  event_id?: string | null;
  cause_event_id?: string | null;
  cause_tag?: string | null;
  cause_target?: string | null;
  reason_code?: string | null;
  agentic_process_id?: string | null;
  error?: string | null;
  actions?: string[];
  [key: string]: unknown;
}

/** Every tag whose events name a projected stream inbox message (`stream_inbox_on_tag.py`). */
export const MESSAGE_PROJECTED = 'stream_inbox.*.message.projected';

/** Whether a tag pattern is one a rule on messages arriving listens to: every channel's, or one channel's
 *  (`stream_inbox.<segment>.message.projected`) — what the backend's subject answers for. */
const MESSAGE_PATTERN = /^stream_inbox\.[^.]+\.message\.projected$/;
export const isMessagePattern = (pattern: string | null | undefined): boolean => MESSAGE_PATTERN.test(pattern ?? '');

/** What a rule on messages arriving needs: the sentence, the channels, the agent and its prompt. */
export interface MessageRule {
  catch: string;
  /** Data source ids (bare or `data_source:`-prefixed). Empty = any channel. */
  sources?: string[];
  /** `agent-<uuid>`, or the bare uuid. */
  agent: string;
  prompt: string;
  name?: string | null;
  enabled?: boolean;
  project_id?: string | null;
}

/** The fields a message rule is saved as — ONE row shape for the SDK builder and the screen's Save, and the
 *  one name rule ("Asks for a refund → Billing helper"). `agentName` only feeds the default name. */
export function messageRuleFields(rule: MessageRule, agentName = ''): Partial<ITrigger> & { name: string } {
  const sentence = rule.catch.trim().replace(/\.$/, '');
  const capitalised = `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
  return {
    name: rule.name || `${capitalised} → ${agentName || 'an agent'}`,
    trigger_type: 'tag',
    tag_pattern: MESSAGE_PROJECTED,
    tag_scope: (rule.sources ?? []).map((id) => targetOf('data_source', parseTarget(id)[1] ?? id)),
    gate: { sentence },
    then: { run_agent: { agent: rule.agent && !rule.agent.startsWith('agent-') ? `agent-${rule.agent}` : rule.agent, prompt: rule.prompt.trim() } },
    enabled: rule.enabled ?? true,
    ...(rule.project_id !== undefined ? { project_id: rule.project_id } : {}),
  };
}

export interface ITrigger extends IEntity {
  name: string;
  description?: string;
  trigger_type?: 'hook' | 'schedule' | 'fsop' | 'tag';
  /** Stable name minted by the reconciler, e.g. `wizard_<slug>_<i>`. It is the
   *  only join between a DECLARED trigger (in a document) and the row that
   *  records whether it has actually fired. */
  uname?: string;
  // TAG trigger fields — a bus subscription. A wizard declares these in its
  // own document and the backend reconciles them into a row at startup.
  /** Bus tag pattern, e.g. `app.ready`. Trailing `*` matches a suffix. */
  tag_pattern?: string;
  /** Only fire for events about this target (`type:id`). */
  tag_target?: string;
  /** Colon-form targets the event's `ctx.scope` must intersect (`data_source:<id>`). */
  tag_scope?: string[];
  /** Fire at most once per machine, ever — `counter` is the durable record, so
   *  a spent trigger is suppressed rather than deleted and still shows that it
   *  ran. */
  fire_once?: boolean;
  max_fires_per_minute?: number;
  /** Confirm-against-store gate: `{type, filter}` must match a row. */
  confirm?: { type?: string; filter?: Record<string, unknown> } | null;
  /** The `if`: a `compute_op.decision` op's exe_data (questions, require, input, sentence), asked
   *  before a fire counts. `sentence` is the line a person typed. */
  gate?: TriggerGate | null;
  /** What runs on a fire, as a wizard: `{ref}` | `{steps, ops}` | `{run_agent}` | `{run_script}`. */
  then?: TriggerThen | null;
  // Hook trigger fields
  mask: Record<string, any>;
  action: TriggerAction;
  /** Every action dispatched on fire, in order. A scheduled agent run carries a
   *  `run_agent` action with the prompt; `target_type_id` empty = parent agent. */
  actions?: TriggerActionRow[];
  enabled?: boolean;
  last_triggered?: Date;
  counter?: number;
  scope?: string;
  hook_events?: string[];
  log_mode?: string;
  path?: string;
  // Schedule trigger fields
  expr?: string;
  sched_trigger_type?: 'cron' | 'interval' | 'date';
  /** IANA zone the schedule is read in; empty = the backend machine's zone. */
  timezone?: string | null;
  /** The place (Deployment id) a schedule runs on; empty = every machine (legacy). */
  runs_on?: string | null;
  next_run?: Date;
  last_run?: Date;
  instruction?: string;
  workdir?: string;
  project_id?: string | null;
  // FSOp trigger fields
  watch_path?: string;
  recursive?: boolean;
  watch_glob?: string;
  last_seen_mtime?: number;
  last_seen_size?: number;
}

/** The row's `gate` — `DecisionOp` in `compute_op_spec.py`, as a plain object. */
export interface TriggerGate {
  questions?: Record<string, Record<string, unknown>>;
  require?: Record<string, Record<string, unknown>>;
  /** The scope value the questions are about (`MESSAGE` for a stream inbox rule). */
  input?: string;
  sentence?: string;
}

/** The row's `then` — `ThenSpec` in `trigger_spec.py`. Exactly one form is present. */
export interface TriggerThen {
  ref?: string;
  steps?: Record<string, unknown>[];
  ops?: Record<string, Record<string, unknown>>;
  run_agent?: { agent: string; prompt: string } | null;
  run_script?: string | null;
}

/** One entry of a trigger row's `actions` — `flow_sdk/schema/data_spec/trigger_action.py`. */
export interface TriggerActionRow {
  action_type: 'nop' | 'notify_entity' | 'run_script' | 'callback' | 'run_agent' | string;
  script_path?: string | null;
  script_filename?: string | null;
  callback_name?: string | null;
  target_type_id?: string | null;
  prompt?: string | null;
}

// `implements ITrigger` only checks the class; it contributes no members, so every
// field declared solely on ITrigger read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Trigger extends EntityMerge<ITrigger> {}

/**
 * Entity representing a trigger that matches hook data and executes actions
 */
@registerEntity
export class Trigger extends APIEntity<Trigger> implements ITrigger {
  static type: string = 'trigger';

  name: string = '';
  description?: string;
  trigger_type: 'hook' | 'schedule' | 'fsop' | 'tag' = 'hook';
  uname?: string;
  tag_pattern?: string;
  tag_target?: string;
  tag_scope?: string[];
  fire_once?: boolean;
  max_fires_per_minute?: number;
  confirm?: { type?: string; filter?: Record<string, unknown> } | null;
  gate?: TriggerGate | null;
  then?: TriggerThen | null;
  // Hook trigger fields
  mask: Record<string, any> = {};
  action: TriggerAction;
  actions: TriggerActionRow[] = [];
  enabled: boolean = true;
  last_triggered?: Date;
  counter: number = 0;
  scope: string = 'system';
  hook_events: string[] = [];
  log_mode: string = 'activations';
  path?: string;
  // Schedule trigger fields
  expr?: string;
  sched_trigger_type?: 'cron' | 'interval' | 'date';
  timezone?: string | null;
  /** The place (Deployment id) a schedule runs on; empty = every machine (legacy). */
  runs_on?: string | null;
  next_run?: Date;
  last_run?: Date;
  instruction?: string;
  workdir?: string;
  project_id?: string | null;
  // FSOp trigger fields
  watch_path?: string;
  recursive?: boolean;
  watch_glob?: string;
  last_seen_mtime?: number;
  last_seen_size?: number;

  constructor(entity: Partial<ITrigger> = {}) {
    super(entity);
    this.name = entity.name || '';
    this.description = entity.description;
    this.trigger_type = entity.trigger_type || 'hook';
    this.mask = entity.mask || {};
    this.action = entity.action || { action_type: 'nop' as any };
    this.actions = entity.actions || [];
    this.enabled = entity.enabled !== undefined ? entity.enabled : true;
    this.last_triggered = entity.last_triggered;
    this.counter = entity.counter ?? 0;
    this.scope = entity.scope || 'system';
    this.hook_events = entity.hook_events || [];
    this.log_mode = entity.log_mode || 'activations';
    this.path = entity.path;
    // The constructor is the ONLY place a field is adopted — a declared field
    // that is not re-applied here is dropped from every fetched row.
    this.uname = entity.uname;
    this.tag_pattern = entity.tag_pattern;
    this.tag_target = entity.tag_target;
    this.tag_scope = entity.tag_scope;
    this.fire_once = entity.fire_once;
    this.max_fires_per_minute = entity.max_fires_per_minute;
    this.confirm = entity.confirm;
    this.gate = entity.gate ?? null;
    this.then = entity.then ?? null;
    this.expr = entity.expr;
    this.sched_trigger_type = entity.sched_trigger_type;
    this.timezone = entity.timezone ?? null;
    this.runs_on = entity.runs_on ?? null;
    this.next_run = entity.next_run;
    this.last_run = entity.last_run;
    this.instruction = entity.instruction;
    this.workdir = entity.workdir;
    this.project_id = entity.project_id ?? null;
    this.watch_path = entity.watch_path;
    this.recursive = entity.recursive;
    this.watch_glob = entity.watch_glob;
    this.last_seen_mtime = entity.last_seen_mtime;
    this.last_seen_size = entity.last_seen_size;
  }

  /** The `run_agent` action, when this trigger runs an agent. */
  get runAgentAction(): TriggerActionRow | undefined {
    return this.actions.find((a) => a.action_type === 'run_agent');
  }

  /** The agent this trigger runs — the `then` sugar's, else the action's explicit target, else its parent. */
  get runAgentTypeId(): string | null {
    const explicit = this.then?.run_agent ? this.then.run_agent.agent : this.runAgentAction?.target_type_id;
    if (explicit === undefined) return null;
    const target = explicit || this.parent_type_id || '';
    return target.startsWith('agent-') ? target : null;
  }

  /** A rule on messages arriving (docs/snippets/stream-inbox-automations.md §2). */
  get isMessageRule(): boolean {
    return this.trigger_type === 'tag' && isMessagePattern(this.tag_pattern);
  }

  // ── Automations (docs/automations.md) ──────────────────────────────────────
  // The Automations screen reaches the backend only through these. Each wraps one
  // `Trigger` action in `flow_sdk/builtin/trigger.py`; answers are the
  // `automation.*` shapes in `./automation-types`.

  /** Every automation as a sentence with its health — the whole list in one call. */
  static async overview(options: { includeInactive?: boolean } = {}): Promise<AutomationSummary[]> {
    const action = new ActionInfo('overview', Trigger.type, null, 'GET' as HttpMethod);
    if (options.includeInactive) action.queryParameters = { include_inactive: 'true' };
    return ((await dataManager.callAction<undefined, AutomationSummary[]>(action)) as AutomationSummary[]) ?? [];
  }

  /** When a schedule (saved or still being edited) fires next, and how it reads. */
  static async nextRuns(
    schedule: { expr: string; sched_trigger_type?: string | null; timezone?: string | null },
    n = 5,
  ): Promise<NextRuns> {
    const action = new ActionInfo('next_runs', Trigger.type, null, 'GET' as HttpMethod);
    action.queryParameters = {
      expr: schedule.expr,
      sched_trigger_type: schedule.sched_trigger_type || 'cron',
      timezone: schedule.timezone || '',
      n: String(n),
    };
    return (await dataManager.callAction<undefined, NextRuns>(action)) as NextRuns;
  }

  // ── Stream stream inbox automations (docs/snippets/stream-inbox-automations.md) ───────────────

  /**
   * A rule on messages arriving: when one lands on `sources` (every channel when none), if
   * `catch` is true of it, have `agent` do `prompt` with the message as its input. The backend
   * words the sentence into the gate's question (`Trigger.on_message`); this sends the same
   * fields `create` takes, so the screen's Save and the Python builder make the same row.
   */
  static async onMessage(rule: MessageRule): Promise<Trigger> {
    return Trigger.createAutomation(messageRuleFields({ project_id: null, ...rule }));
  }

  /** How many of the person's own rules fired in the last hour — the top-bar counter, one light call. */
  static async startedLastHour(): Promise<number> {
    const action = new ActionInfo('started_last_hour', Trigger.type, null, 'GET' as HttpMethod);
    return Number((await dataManager.callAction<undefined, number>(action)) ?? 0);
  }

  /** The fast test: ask the rule's gate about `text` or one `messageId`. Records nothing, runs nothing. */
  static async decideOn(triggerId: string, about: { text?: string; messageId?: string }): Promise<DecisionVerdict> {
    const action = new ActionInfo('decide_on', Trigger.type, triggerId, 'POST' as HttpMethod);
    action.bodyParameters = about.messageId ? { message_id: about.messageId } : { text: about.text ?? '' };
    return (await dataManager.callAction<undefined, DecisionVerdict>(action)) as DecisionVerdict;
  }

  /** The fast test for a rule not saved yet, or edited: the builder's fields and the text (or a message id). */
  static async decideSpec(spec: Partial<ITrigger>, about: { text?: string; messageId?: string }): Promise<DecisionVerdict> {
    const action = new ActionInfo('decide_spec', Trigger.type, null, 'POST' as HttpMethod);
    action.bodyParameters = {
      spec: { ...spec },
      ...(about.messageId ? { message_id: about.messageId } : { text: about.text ?? '' }),
    } as Record<string, unknown>;
    return (await dataManager.callAction<undefined, DecisionVerdict>(action)) as DecisionVerdict;
  }

  /** The try list: recent messages on the rule's sources, each with what the gate says of it. */
  static async decideOnRecent(triggerId: string, options: { limit?: number } = {}): Promise<TryRow[]> {
    const action = new ActionInfo('decide_on_recent', Trigger.type, triggerId, 'GET' as HttpMethod);
    action.queryParameters = { limit: String(options.limit ?? 20) };
    return ((await dataManager.callAction<undefined, TryRow[]>(action)) as TryRow[]) ?? [];
  }

  /** Runs newest first — one automation's, or every automation's. */
  static async runs(query: RunsQuery = {}): Promise<AutomationRun[]> {
    const action = new ActionInfo('runs', Trigger.type, null, 'GET' as HttpMethod);
    const params: Record<string, string> = {};
    if (query.triggerId) params.trigger_id = query.triggerId;
    if (query.status) params.status = query.status;
    if (query.includeTests === false) params.include_tests = 'false';
    if (query.includeDeclined) params.include_declined = 'true';
    if (query.includeBuiltin === false) params.include_builtin = 'false';
    if (query.limit) params.limit = String(query.limit);
    action.queryParameters = params;
    return ((await dataManager.callAction<undefined, AutomationRun[]>(action)) as AutomationRun[]) ?? [];
  }

  /** One run by its history row id, with its agent run's outcome. */
  static async run(runId: string): Promise<AutomationRun> {
    const action = new ActionInfo('run', Trigger.type, null, 'GET' as HttpMethod);
    action.queryParameters = { id: runId };
    return (await dataManager.callAction<undefined, AutomationRun>(action)) as AutomationRun;
  }

  /**
   * *Run once now*: runs even when the automation is off and spends nothing a
   * real fire spends. `event` picks what an event automation runs with. Answers
   * at once; the run shows up in {@link Trigger.runs}.
   */
  static async runOnce(
    triggerId: string,
    event?: AutomationTestEvent | null,
    options: { messageId?: string } = {},
  ): Promise<RunOnceStarted> {
    const action = new ActionInfo('test', Trigger.type, triggerId, 'POST' as HttpMethod);
    action.bodyParameters = {
      ...(event ? { event: { ...event } } : {}),
      ...(options.messageId ? { message_id: options.messageId } : {}),
    };
    return (await dataManager.callAction<undefined, RunOnceStarted>(action)) as RunOnceStarted;
  }

  /** *Check* a saved automation — would it run, and what would it do. No side effects. */
  static async check(triggerId: string, event?: AutomationTestEvent | null): Promise<AutomationCheck> {
    const action = new ActionInfo('check', Trigger.type, triggerId, 'POST' as HttpMethod);
    action.bodyParameters = event ? { event: { ...event } } : {};
    return (await dataManager.callAction<undefined, AutomationCheck>(action)) as AutomationCheck;
  }

  /** *Check* an automation that is not saved yet, from the builder's fields. */
  static async checkSpec(spec: Partial<ITrigger>, event?: AutomationTestEvent | null): Promise<AutomationCheck> {
    const action = new ActionInfo('check_spec', Trigger.type, null, 'POST' as HttpMethod);
    action.bodyParameters = { spec: { ...spec }, ...(event ? { event: { ...event } } : {}) } as Record<string, unknown>;
    return (await dataManager.callAction<undefined, AutomationCheck>(action)) as AutomationCheck;
  }

  /** Recent real events to test a saved event automation with, newest first. */
  static async samples(triggerId: string): Promise<AutomationSample[]> {
    const action = new ActionInfo('samples', Trigger.type, triggerId, 'GET' as HttpMethod);
    return ((await dataManager.callAction<undefined, AutomationSample[]>(action)) as AutomationSample[]) ?? [];
  }

  /** Recent forwarded events a pattern would receive — for an automation not saved yet. */
  static async recentEvents(pattern: string, target?: string | null): Promise<AutomationSample[]> {
    const action = new ActionInfo('recent_events', Trigger.type, null, 'GET' as HttpMethod);
    action.queryParameters = { pattern, ...(target ? { target } : {}) };
    return ((await dataManager.callAction<undefined, AutomationSample[]>(action)) as AutomationSample[]) ?? [];
  }

  /** The event bus as a map: every event type, its count since start, who listens, what they do. */
  static async busMap(): Promise<BusMap> {
    const action = new ActionInfo('bus_map', Trigger.type, null, 'GET' as HttpMethod);
    return (await dataManager.callAction<undefined, BusMap>(action)) as BusMap;
  }

  /** The pattern sandbox: would `pattern` (and a target filter) receive this event. Saves nothing. */
  static async matchPattern(
    pattern: string,
    event: { tag: string; target: string; scope?: string[] },
    targetFilter?: string | null,
  ): Promise<PatternMatch> {
    const action = new ActionInfo('match_pattern', Trigger.type, null, 'POST' as HttpMethod);
    action.bodyParameters = { pattern, event: { ...event }, ...(targetFilter ? { target_filter: targetFilter } : {}) };
    return (await dataManager.callAction<undefined, PatternMatch>(action)) as PatternMatch;
  }

  /** Create an automation from its fields (`trigger_type`, `name`, the kind's fields, `actions`). */
  static async createAutomation(fields: Partial<ITrigger> & { name: string }): Promise<Trigger> {
    const action = new ActionInfo('create', Trigger.type, null, 'POST' as HttpMethod);
    action.bodyParameters = { ...fields } as Record<string, unknown>;
    return new Trigger((await dataManager.callAction<undefined, ITrigger>(action)) as ITrigger);
  }

  /** Change an automation's fields; the backend re-arms it. */
  static async updateAutomation(triggerId: string, patch: Partial<ITrigger>): Promise<Trigger> {
    const action = new ActionInfo('update', Trigger.type, triggerId, 'PATCH' as HttpMethod);
    action.bodyParameters = { ...patch } as Record<string, unknown>;
    return new Trigger((await dataManager.callAction<undefined, ITrigger>(action)) as ITrigger);
  }

  /** Switch an automation on or off. */
  static async setEnabled(triggerId: string, enabled: boolean): Promise<Trigger> {
    return Trigger.updateAutomation(triggerId, { enabled });
  }

  /** Delete an automation; the backend disarms it first. */
  static async remove(triggerId: string): Promise<void> {
    const action = new ActionInfo('delete', Trigger.type, triggerId, 'DELETE' as HttpMethod);
    await dataManager.callAction(action);
  }

  /** An agent rule's `trigger.py`. Rejects (404) for any other kind. */
  static async getCode(triggerId: string): Promise<string> {
    const action = new ActionInfo('trigger-content', Trigger.type, triggerId, 'GET' as HttpMethod);
    const data = (await dataManager.callAction<undefined, { content?: string }>(action)) as { content?: string } | null;
    return data?.content ?? '';
  }

  static async setCode(triggerId: string, content: string): Promise<void> {
    const action = new ActionInfo('trigger-content', Trigger.type, triggerId, 'PUT' as HttpMethod);
    action.bodyParameters = { content };
    await dataManager.callAction(action);
  }

  /** Raw history rows for one rule (by its name), newest first. Prefer {@link Trigger.runs}. */
  static async log(triggerId: string, options: { limit?: number; triggeredOnly?: boolean } = {}): Promise<TriggerLogRow[]> {
    const action = new ActionInfo('log', Trigger.type, triggerId, 'GET' as HttpMethod);
    action.queryParameters = {
      limit: String(options.limit ?? 500),
      triggered_only: options.triggeredOnly ? 'true' : 'false',
    };
    return ((await dataManager.callAction<undefined, TriggerLogRow[]>(action)) as TriggerLogRow[]) ?? [];
  }

  /**
   * Discover all activation rules from the filesystem and sync them as Trigger entities.
   * Calls GET /api/v1/graph/trigger/discover
   */
  static async discover(): Promise<Trigger[]> {
    const action = new ActionInfo('discover', Trigger.type, null, 'GET' as HttpMethod);
    const response = await dataManager.callAction<undefined, ITrigger[]>(action);
    return (response as ITrigger[] || []).map((d) => new Trigger(d));
  }

  /**
   * List all triggers
   */
  static async list(): Promise<Trigger[]> {
    const request = new QueryRequest({
      type: Trigger.type,
      query: null,
      scope: [],
    });
    return await Trigger.query(request, true); // invalidate cache to get fresh data
  }

  /**
   * Check if the hook data matches this trigger's mask
   *
   * Uses simple key-value matching. All key-value pairs in the mask must
   * exactly match the corresponding fields in the hook data.
   */
  match(hookData: HookEventData): boolean {
    if (!this.enabled) {
      return false;
    }

    for (const [key, expectedValue] of Object.entries(this.mask)) {
      const actualValue = (hookData as any)[key];

      if (actualValue === undefined) {
        return false;
      }

      if (actualValue !== expectedValue) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get all agent hooks connected to this trigger
   */
  async getAgentHooks(): Promise<AgentHook[]> {
    if (!this.id) {
      throw new Error('Cannot get agent hooks for unsaved Trigger');
    }

    const action = new ActionInfo('agent_hook', Trigger.type, this.id, 'GET' as HttpMethod);
    const response = await dataManager.callAction<undefined, AgentHook[]>(action);

    if (response && Array.isArray(response)) {
      return response.map((data: any) => new AgentHook(data));
    }
    return [];
  }

  /**
   * Connect this trigger to an agent hook
   */
  async connectToAgentHook(agentHook: AgentHook | TypeId): Promise<void> {
    if (!this.id) {
      throw new Error('Cannot connect unsaved Trigger');
    }

    const hookId = agentHook instanceof AgentHook ? agentHook.id : agentHook.id;
    if (!hookId) {
      throw new Error('Cannot connect to AgentHook without ID');
    }

    const action = new ActionInfo('agent_hook', Trigger.type, this.id, 'POST' as HttpMethod);
    action.subpath = RelationshipSubAction.ADD;
    action.bodyParameters = {
      agent_hook_id: { type: AgentHook.type, id: hookId },
    };
    await dataManager.callAction(action);
  }

  /**
   * Disconnect this trigger from an agent hook
   */
  async disconnectFromAgentHook(agentHook: AgentHook | TypeId): Promise<void> {
    if (!this.id) {
      throw new Error('Cannot disconnect unsaved Trigger');
    }

    const hookId = agentHook instanceof AgentHook ? agentHook.id : agentHook.id;
    if (!hookId) {
      throw new Error('Cannot disconnect from AgentHook without ID');
    }

    const action = new ActionInfo('agent_hook', Trigger.type, this.id, 'POST' as HttpMethod);
    action.subpath = RelationshipSubAction.REMOVE;
    action.bodyParameters = {
      agent_hook_id: { type: AgentHook.type, id: hookId },
    };
    await dataManager.callAction(action);
  }
}

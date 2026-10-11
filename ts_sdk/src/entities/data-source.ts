/**
 * DataSource — a configured source we sync from: files, records or messages
 * (flow_sdk/builtin/data_source.py).
 *
 * NOT to be confused with `FlowDataSource` in `ts_sdk/src/flow_processing/` —
 * that is the origin enum on a trace's FlowData (stream | history | …) and has
 * nothing to do with ingestion. See docs/glossary.md.
 */
// The module rather than the `../models` barrel — one class is all this needs, and the
// barrel re-exports most of the SDK's model layer.
import { ActionInfo } from '../models/ActionInfo';
import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity, EntityMerge } from '../IEntity';
import type { SetupStageState } from './data-driver';

/** Mirror of flow_sdk/ingest/health.py SourceHealth. */
export type SourceHealth = 'never_synced' | 'ok' | 'transient_error' | 'config_error';

/**
 * Mirror of flow_sdk/builtin/data_source.py SourceStatus — the LIFECYCLE, which
 * is a different question from `health`: status says whether this source should
 * be running, health says whether it works. The state that needed both is a
 * Slack source whose bot has not been invited yet — nobody paused it, and it
 * would ingest nothing if polled. The boolean `enabled` this replaces could not
 * express that, so such a source read as healthy-and-idle forever.
 *
 * `new` is transient: `save()` resolves it to `setup` (the driver has a
 * verification step) or `active` (it does not) before the row ever lands.
 */
export type SourceStatus = 'new' | 'setup' | 'active' | 'disabled';

/** What the channel confirmed about one sent message (data_source.py `_outcome_dict`).
 *  `recorded: false` on a sent message means the local copy is missing — never re-send to fix it. */
export interface DataSourceSendOutcome {
  external_id: string;
  status: 'sent' | 'drafted';
  recorded: boolean;
  artifact_id: string;
}

export interface IDataSource extends IEntity {
  /** The source's asset folder on this machine (`agentic-assets/data_source/<name>/`). */
  asset_ref?: string | null;
  owner?: string | null;
  name: string;
  kind?: string;
  provider?: string;
  channel?: string;
  account_key?: string;
  account_identities?: string[];
  allowed_senders?: string[];
  required_capabilities?: string[];
  config?: Record<string, unknown>;
  status?: SourceStatus;
  setup_detail?: string;
  verified_at?: string | null;
  poll_interval_seconds?: number;
  window_days?: number;
  thread_timeout_seconds?: number | null;
  /** Where a file source's payload lands locally: `record` | `none` | `copy` | `symlink`. */
  reflect?: string;
  /** The folder a `copy`/`symlink` source places into. */
  reflect_into?: string;
  /** The local copy is kept out of git (default true). */
  gitignored?: boolean;
  /** Pull only: never write back to the remote (default false). */
  read_only?: boolean;
  /** Where a file source's files are on this machine (the folder it places them in, else its own tree);
   *  null for a record source or one that names no folder yet. Derived by the backend, never stored. */
  files_root?: string | null;
  cursor?: string | null;
  manifest?: Record<string, unknown>;
  high_water?: string | null;
  last_attempted_at?: string | null;
  consecutive_failures?: number;
  next_poll_at?: string | null;
  last_synced_at?: string | null;
  health?: SourceHealth;
  error_code?: string | null;
  error_detail?: string | null;
}

// `implements IDataSource` only checks the class; it contributes no members, so every
// field declared solely on IDataSource read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DataSource extends EntityMerge<IDataSource> {}

/** Where a hub webhook claim hands this channel's messages (the hub's `DeliveryTarget`). */
export interface ChannelRouteTarget {
  kind: 'none' | 'desktop' | 'node';
  instance_id?: string;
  node_typeid?: string;
  data_source_id?: string;
}

/** The hub claim that delivers to a channel, as the owner sees it (never a secret). */
export interface ChannelRouteClaim {
  id: string;
  url: string;
  provider: string;
  status: 'pending' | 'active' | 'lapsed';
  claim?: { kind: 'root' | 'account' | 'user' | 'group'; key: string } | null;
  target: ChannelRouteTarget;
  deliveries: number;
  misroutes: number;
  recent: { at: number; method: string; sub_path?: string; status: number }[];
}

/** One place a channel's messages can be pointed at: this computer, or a cloud placement of its agent. */
export interface ChannelRoutePlace {
  key: string;
  label: string;
  node_typeid?: string;
}

/** `GET data_source/<id>/route`: the claim (null before the channel is connected), its places, the current one. */
export interface ChannelRoute {
  claim: ChannelRouteClaim | null;
  places: ChannelRoutePlace[];
  /** `this`, a deployment id, or '' when it points elsewhere. */
  current: string;
  /** Further places the same messages are ALSO delivered to — one more claim each (`add_route`). */
  also?: { claim_id: string; key: string; label: string }[];
}

/** Where a channel's messages arrive, from this instance's point of view: a hub claim delivering to `this`
 *  computer, another `instance`, a `node`, `nowhere` yet — `unclaimed` when the source receives only through a claim
 *  and has none (it needs Connect), or `polls` when the source fetches its own. */
export type ChannelRouted = 'this' | 'instance' | 'node' | 'nowhere' | 'unclaimed' | 'polls';

/** One MessageChannel (`GET data_source/channels`): a message source and the hub claim that delivers to it. A hub
 *  claim whose channel is not on this instance comes with no `source_id`. */
export interface MessageChannelRow {
  source_id: string;
  name: string;
  provider: string;
  channel: string;
  claim: ChannelRouteClaim | null;
  routed: ChannelRouted;
  /** Who answers it: one of its owner's deployments, its owning agent, or nobody yet ('' with no source here). */
  answered_by: 'deployment' | 'agent' | 'nobody' | '';
}

/** One thing a provider says can be picked. Mirrors `Choice` in `choice_spec.py`. */
export interface DataSourceChoice {
  id: string;
  name: string;
  detail?: string;
}

/** One field's offer: what can be picked, or why nothing can. Mirrors `ChoiceSet`. */
export interface DataSourceChoiceSet {
  items: DataSourceChoice[];
  detail: string;
}

// The decorator binds to the declaration IMMEDIATELY below it. Anything slipped in
// between silently unhooks it — the class stops registering, and the store then has no
// constructor for `data_source`, so every list of sources renders empty with nothing
// throwing. Keep declarations above this line.
@registerEntity
export class DataSource extends APIEntity<DataSource> implements IDataSource {
  static type: string = 'data_source';

  name: string = '';
  kind: string = '';
  provider: string = '';
  /** The user-facing channel (gmail | slack | …), which is NOT `provider`: the
   *  agent transport's provider is literally "agent" while its channel is the
   *  connector it reaches. Backend-owned — `sync_source` writes it from the
   *  driver on every poll, so never set it from a form. */
  channel: string = '';
  account_key: string = '';
  /** Whose source this is — a user or agent typeid string, or null on rows
   *  written before ownership existed (read as the local user's). */
  owner: string | null = null;
  /** Addresses that are ME on this source. Display/round-trip only. */
  account_identities: string[] = [];
  /** Who may drive the owning agent from this channel — sender external ids
   *  (a Slack member id, an email address), one per provider's own namespace.
   *  Empty admits nobody: see `AgentMailbox.allowed`, the gate this backs for
   *  every channel-bound agent, not only an allocated mailbox. */
  allowed_senders: string[] = [];
  required_capabilities: string[] = [];
  config: Record<string, unknown> = {};
  status: SourceStatus = 'new';
  /** What is still missing, in the user's words — "Invite the Flowpad bot to
   *  #eng, then press Verify again." Written by the driver's verdict, so the
   *  card never has to guess why a source is in `setup`. */
  setup_detail: string = '';
  verified_at: string | null = null;
  poll_interval_seconds: number = 300;
  window_days: number = 7;
  /** A thread quiet this long is over: the next message starts a new thread. Null = never. */
  thread_timeout_seconds: number | null = null;
  /** The provider's opaque resume token — one per source, since a source is ONE
   *  stream. Null until the first pass completes, and after `reset`. */
  cursor: string | null = null;
  /** The last pass's listing snapshot, for drivers that diff rather than resume.
   *  A dict on the wire (never null) — the backend declares it one. */
  manifest: Record<string, unknown> = {};
  /** ISO timestamp of the newest item synced so far. */
  high_water: string | null = null;
  last_attempted_at: string | null = null;
  /** Failed polls in a row; resets on the next success. */
  consecutive_failures: number = 0;
  next_poll_at: string | null = null;
  last_synced_at: string | null = null;
  health: SourceHealth = 'never_synced';
  error_code: string | null = null;
  error_detail: string | null = null;

  constructor(entity: Partial<IDataSource> = {}) {
    super(entity);
    this.name = entity.name ?? this.name;
    this.kind = entity.kind ?? this.kind;
    this.provider = entity.provider ?? this.provider;
    this.channel = entity.channel ?? this.channel;
    this.account_key = entity.account_key ?? this.account_key;
    this.owner = entity.owner ?? this.owner;
    this.account_identities = entity.account_identities ?? this.account_identities;
    this.allowed_senders = entity.allowed_senders ?? this.allowed_senders;
    this.required_capabilities = entity.required_capabilities ?? this.required_capabilities;
    this.config = entity.config ?? this.config;
    this.status = entity.status ?? this.status;
    this.setup_detail = entity.setup_detail ?? this.setup_detail;
    this.verified_at = entity.verified_at ?? this.verified_at;
    this.poll_interval_seconds = entity.poll_interval_seconds ?? this.poll_interval_seconds;
    this.window_days = entity.window_days ?? this.window_days;
    this.thread_timeout_seconds = entity.thread_timeout_seconds ?? this.thread_timeout_seconds;
    this.cursor = entity.cursor ?? this.cursor;
    this.manifest = entity.manifest ?? this.manifest;
    this.high_water = entity.high_water ?? this.high_water;
    this.last_attempted_at = entity.last_attempted_at ?? this.last_attempted_at;
    this.consecutive_failures = entity.consecutive_failures ?? this.consecutive_failures;
    this.next_poll_at = entity.next_poll_at ?? this.next_poll_at;
    this.last_synced_at = entity.last_synced_at ?? this.last_synced_at;
    this.health = entity.health ?? this.health;
    this.error_code = entity.error_code ?? this.error_code;
    this.error_detail = entity.error_detail ?? this.error_detail;
  }

  /** Running, as opposed to paused, unfinished, or never resolved. */
  get isActive(): boolean {
    return this.status === 'active';
  }

  /** Nobody has decided how it starts yet (`DataSource.poll_refusal`: "has not been evaluated"). Transient
   *  by design — a save resolves it — but a row that lingers here is never polled. */
  get isUnresolved(): boolean {
    return this.status === 'new';
  }

  /** Waiting on the user to finish something outside Flowpad (a Slack invite). */
  get needsSetup(): boolean {
    return this.status === 'setup';
  }

  /** Running, but `is_due` refuses it: parked on `config_error` until a person
   *  fixes the config. A PAUSED source carrying a stale error is not this. */
  get isParked(): boolean {
    return this.isActive && this.health === 'config_error';
  }

  /** Running, but a file changed both locally and remotely, so write-back wrote neither and waits for a person
   *  to make them agree (`error_detail` names the files). Not broken: the source keeps polling. */
  get isHeld(): boolean {
    return this.health === 'ok' && this.error_code === 'write_back_held';
  }

  /** Stopped on purpose: nothing is fetched until a person resumes it. */
  get isPaused(): boolean {
    return this.status === 'disabled';
  }

  /** Running, and the last poll failed on something the scheduler retries by itself. Like `isParked`,
   *  a PAUSED source carrying a stale error is not this. */
  get isRetrying(): boolean {
    return this.isActive && this.health === 'transient_error';
  }

  /** Mirrors DataSource.is_due — why a source that looks configured sits idle. */
  get isDue(): boolean {
    if (!this.isActive) return false;
    if (this.health === 'config_error') return false;
    if (!this.next_poll_at) return true;
    return new Date(this.next_poll_at).getTime() <= Date.now();
  }

  /** Every MessageChannel and where it is routed. */
  static async channels(): Promise<MessageChannelRow[]> {
    const info = new ActionInfo('channels', DataSource.type, null, 'GET');
    const data = await dataManager.callAction<unknown, { channels: MessageChannelRow[] }>(info);
    return data?.channels ?? [];
  }

  /**
   * What this credential can offer for one choosable config field — buckets, shared
   * drives, channels.
   *
   * Class-level, with no entity id, because the picker's whole job is to fill the form
   * for a source that does not exist yet. POST though it reads nothing: the in-progress
   * config travels with it, and a draft config is where a secret lives on some providers.
   *
   * A refusal comes back as an empty `items` and a sentence in `detail` — never a thrown
   * error — because every cause (no connection, a missing scope, no project id) means the
   * same thing to the person filling the form: type it instead.
   */
  static async choices(
    provider: string,
    field: string,
    config: Record<string, unknown> = {},
  ): Promise<DataSourceChoiceSet> {
    const info = new ActionInfo('choices', DataSource.type, null, 'POST');
    info.bodyParameters = { provider, field, config };
    return dataManager.callAction<unknown, DataSourceChoiceSet>(info);
  }

  /**
   * Make this source due on the next heartbeat tick (≤60s) — NOT synchronous.
   * Also the only un-latch for `config_error`, which `is_due` otherwise refuses
   * forever.
   */
  async pollNow(): Promise<{ status: string; health: SourceHealth; detail: string }> {
    return this.post('poll_now');
  }

  /** The setup wizards this source's driver declares, each as it stands for THIS source. */
  async setupStages(): Promise<SetupStageState[]> {
    return this.get('setup_stages');
  }

  /** Which place the hub hands this channel's messages to — read from the hub, never cached. */
  async route(): Promise<ChannelRoute> {
    return this.get('route');
  }

  /** Point this channel's messages at `place` (`this` or a deployment id). Its URL stays; the vendor is untouched. */
  async setRoute(place: string): Promise<{ claim: ChannelRouteClaim; current: string }> {
    return this.post('set_route', { place });
  }

  /** Also deliver this channel's messages to one of its agent's cloud placements (a deployment id). */
  async addRoute(place: string): Promise<{ claim: ChannelRouteClaim; place: string }> {
    return this.post('add_route', { place });
  }

  /**
   * Attention: someone is LOOKING at this source's output — poll on the next
   * heartbeat tick. Fired on an interval by a selected view; the request
   * stream itself is the liveness signal, so nothing is stored and nothing
   * needs undoing when the viewer goes away. Unlike `pollNow` it never
   * un-latches `config_error` and never wakes a disabled source.
   */
  async requestPoll(): Promise<{ status: string; health: SourceHealth; detail: string }> {
    return this.post('request_poll');
  }

  /**
   * Forget sync position (high-water + provider-opaque state) so the next poll
   * re-reads the whole window. On its own this changes nothing visible: ids are
   * deterministic and the content digest still matches, so pair it with
   * `purgeItems` for a re-fetch you can actually see.
   */
  async reset(): Promise<{ status: string; detail: string }> {
    return this.post('reset');
  }

  /** Drop this source's records. Re-ingest rebuilds equivalent rows (new ids —
   *  identity is the natural key, not the id); local state (read / starred) is
   *  the real thing lost. */
  async purgeItems(): Promise<{ status: string; removed: number }> {
    return this.post('purge_items');
  }

  /**
   * Re-fetch: drop the records AND clear the sync position, then go.
   *
   * The composite the UI should call, because either primitive alone is
   * invisible — clearing position re-reads records that are already present and
   * digest-identical, and dropping records without clearing position means the
   * next poll never re-reads them.
   *
   * `since` (ISO-8601) bounds it: only records at or after that instant are
   * dropped, and the window is widened if needed so the driver can actually
   * reach back that far. Undated records are kept — they cannot be shown to
   * fall inside the range. Omit it to replay everything.
   */
  async replay(since?: string): Promise<{
    status: string;
    removed: number;
    since: string | null;
    window_days: number;
    window_widened: boolean;
    detail: string;
  }> {
    return this.post('replay', since ? { since } : undefined);
  }

  /** Send one message into the channel. `to` is what the channel addresses (a chat, a channel
   *  id, an address); the source class decides how it reads it. */
  async send(message: {
    to: string;
    text: string;
    thread_key?: string;
    subject?: string;
    in_reply_to?: string;
  }): Promise<DataSourceSendOutcome> {
    return this.post('send', message);
  }

  /** Reply to one of this source's records; who it reaches is the channel's rule. */
  async reply(itemId: string, text: string): Promise<DataSourceSendOutcome> {
    return this.post('reply', { item_id: itemId, text });
  }

  /** This source's records, newest first. */
  async items(limit = 20): Promise<{ items: Array<Record<string, unknown>> }> {
    return this.post('items', { limit });
  }

  /** One sync cycle NOW, reported — unlike `pollNow`, which only marks the source due. */
  async syncNow(): Promise<{
    created: number;
    updated: number;
    unchanged: number;
    health: SourceHealth;
    status: SourceStatus;
  }> {
    return this.post('sync');
  }

  /** Resume or stop polling. */
  async setEnabled(enabled: boolean): Promise<{ status: SourceStatus }> {
    return this.post('set_enabled', { enabled });
  }

  /**
   * Re-run setup verification: the connection first, then the driver's own
   * check. A source only becomes `active` when both pass.
   *
   * Idempotent and safe to press repeatedly — it is the button beside "invite
   * the bot to the channel", and the only way out of `setup`.
   */
  async verify(): Promise<VerifyResult> {
    return this.post('verify');
  }
}

/** What `DataSource.verify` answers — the same shape the stream inbox's attention bar shows in place. */
export interface VerifyResult {
  status: SourceStatus;
  ready: boolean;
  /** Which layer answered: a dead token and an un-invited bot both leave the
   *  source in `setup`, but they are fixed in different places. */
  layer: 'connection' | 'setup';
  detail: string;
  /** What is still not ready. Absent when the connection layer answered —
   *  it never got as far as the driver's own check. */
  pending?: string[];
  /** The provider did not answer, so nothing is known about the setup; the status stands. */
  transient?: boolean;
}

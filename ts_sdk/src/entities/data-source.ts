/**
 * DataSource — a configured remote system of record we sync from
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

export interface IDataSource extends IEntity {
  owner?: string | null;
  name: string;
  kind?: string;
  provider?: string;
  channel?: string;
  account_key?: string;
  account_identities?: string[];
  required_capabilities?: string[];
  config?: Record<string, unknown>;
  status?: SourceStatus;
  setup_detail?: string;
  verified_at?: string | null;
  poll_interval_seconds?: number;
  window_days?: number;
  segment_count?: number;
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
  /** Streams this source has, rolled up by the poller. Read from here rather
   *  than counting cursor rows: cursors churn on every poll, so watching them
   *  live for a count repaints a list every tick. */
  segment_count: number = 0;
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
    this.required_capabilities = entity.required_capabilities ?? this.required_capabilities;
    this.config = entity.config ?? this.config;
    this.status = entity.status ?? this.status;
    this.setup_detail = entity.setup_detail ?? this.setup_detail;
    this.verified_at = entity.verified_at ?? this.verified_at;
    this.poll_interval_seconds = entity.poll_interval_seconds ?? this.poll_interval_seconds;
    this.window_days = entity.window_days ?? this.window_days;
    this.segment_count = entity.segment_count ?? this.segment_count;
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

  /** Waiting on the user to finish something outside Flowpad (a Slack invite). */
  get needsSetup(): boolean {
    return this.status === 'setup';
  }

  /** The scheduler will not poll it until a person acts: a setup step is owed, or it
   *  is running but parked on `config_error` (`DataSource.poll_refusal`). A PAUSED
   *  source carrying a stale error is not this — resuming it is the fix. */
  get needsAttention(): boolean {
    return this.needsSetup || (this.isActive && this.health === 'config_error');
  }

  /** Mirrors DataSource.is_due — why a source that looks configured sits idle. */
  get isDue(): boolean {
    if (!this.isActive) return false;
    if (this.health === 'config_error') return false;
    if (!this.next_poll_at) return true;
    return new Date(this.next_poll_at).getTime() <= Date.now();
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
  async resetCursors(): Promise<{ status: string; streams: number; detail: string }> {
    return this.post('reset_cursors');
  }

  /** Drop this source's records. Re-ingest rebuilds equivalent rows (new ids —
   *  identity is the natural key, not the id); local state (read / starred) is
   *  the real thing lost. */
  async purgeItems(): Promise<{ status: string; removed: number }> {
    return this.post('purge_items');
  }

  /**
   * Re-fetch: drop the records AND clear the cursor position, then go.
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
    streams: number;
    since: string | null;
    window_days: number;
    window_widened: boolean;
    detail: string;
  }> {
    return this.post('replay', since ? { since } : undefined);
  }

  /**
   * Re-run setup verification: the connection first, then the driver's own
   * check. A source only becomes `active` when both pass.
   *
   * Idempotent and safe to press repeatedly — it is the button beside "invite
   * the bot to the channel", and the only way out of `setup`.
   */
  async verify(): Promise<{
    status: SourceStatus;
    ready: boolean;
    /** Which layer answered: a dead token and an un-invited bot both leave the
     *  source in `setup`, but they are fixed in different places. */
    layer: 'connection' | 'setup';
    detail: string;
    /** Stream keys still not ready. Absent when the connection layer answered —
     *  it never got as far as looking at streams. */
    pending?: string[];
  }> {
    return this.post('verify');
  }
}

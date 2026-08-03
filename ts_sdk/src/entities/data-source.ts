/**
 * DataSource — a configured remote system of record we sync from
 * (flow_sdk/builtin/data_source.py).
 *
 * NOT to be confused with `FlowDataSource` in `ts_sdk/src/flow_processing/` —
 * that is the origin enum on a trace's FlowData (stream | history | …) and has
 * nothing to do with ingestion. See docs/glossary.md.
 */
import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import { HttpMethod } from '../models/ApiUrl';

/** Mirror of flow_sdk/ingest/health.py SourceHealth. */
export type SourceHealth = 'never_synced' | 'ok' | 'transient_error' | 'config_error';

export interface IDataSource extends IEntity {
  name: string;
  kind?: string;
  provider?: string;
  account_key?: string;
  required_capabilities?: string[];
  config?: Record<string, unknown>;
  enabled?: boolean;
  poll_interval_seconds?: number;
  window_days?: number;
  next_poll_at?: string | null;
  last_synced_at?: string | null;
  health?: SourceHealth;
  error_code?: string | null;
  error_detail?: string | null;
}

@registerEntity
export class DataSource extends APIEntity<DataSource> implements IDataSource {
  static type: string = 'data_source';

  name: string = '';
  kind: string = '';
  provider: string = '';
  account_key: string = '';
  required_capabilities: string[] = [];
  config: Record<string, unknown> = {};
  enabled: boolean = true;
  poll_interval_seconds: number = 300;
  window_days: number = 7;
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
    this.account_key = entity.account_key ?? this.account_key;
    this.required_capabilities = entity.required_capabilities ?? this.required_capabilities;
    this.config = entity.config ?? this.config;
    this.enabled = entity.enabled ?? this.enabled;
    this.poll_interval_seconds = entity.poll_interval_seconds ?? this.poll_interval_seconds;
    this.window_days = entity.window_days ?? this.window_days;
    this.next_poll_at = entity.next_poll_at ?? this.next_poll_at;
    this.last_synced_at = entity.last_synced_at ?? this.last_synced_at;
    this.health = entity.health ?? this.health;
    this.error_code = entity.error_code ?? this.error_code;
    this.error_detail = entity.error_detail ?? this.error_detail;
  }

  /** Mirrors DataSource.is_due — why a source that looks configured sits idle. */
  get isDue(): boolean {
    if (!this.enabled) return false;
    if (this.health === 'config_error') return false;
    if (!this.next_poll_at) return true;
    return new Date(this.next_poll_at).getTime() <= Date.now();
  }

  private post<R>(action: string): Promise<R> {
    return dataManager.callAction<undefined, R>(
      new ActionInfo(action, DataSource.type, this.id, 'POST' as HttpMethod),
    );
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
   * Forget sync position (high-water + provider-opaque state) so the next poll
   * re-reads the whole window. On its own this changes nothing visible: ids are
   * deterministic and the content digest still matches, so pair it with
   * `purgeItems` for a re-fetch you can actually see.
   */
  async resetCursors(): Promise<{ status: string; streams: number; detail: string }> {
    return this.post('reset_cursors');
  }

  /** Drop this source's records. Re-ingest rebuilds identical ids; local state
   *  (read / starred) is the real thing lost. */
  async purgeItems(): Promise<{ status: string; removed: number }> {
    return this.post('purge_items');
  }
}

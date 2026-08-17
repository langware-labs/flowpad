/**
 * DataSourceCursor — one sync position per (source, stream)
 * (flow_sdk/builtin/data_source_cursor.py).
 *
 * `state` is provider-opaque by contract: the ingestion subsystem carries it
 * without reading inside (RSS keeps an ETag there, Hacker News an update
 * pointer). Render it, don't interpret it.
 */
import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import type { SourceHealth } from './data-source';

export interface IDataSourceCursor extends IEntity {
  data_source_id?: string;
  stream_key?: string;
  stream_label?: string;
  enabled?: boolean;
  high_water?: string | null;
  state?: Record<string, unknown>;
  last_synced_at?: string | null;
  last_attempted_at?: string | null;
  health?: SourceHealth;
  error_code?: string | null;
  error_detail?: string | null;
  consecutive_failures?: number;
}

@registerEntity
export class DataSourceCursor extends APIEntity<DataSourceCursor> implements IDataSourceCursor {
  static type: string = 'data_source_cursor';

  data_source_id: string = '';
  stream_key: string = '';
  stream_label: string = '';
  enabled: boolean = true;
  high_water: string | null = null;
  state: Record<string, unknown> = {};
  last_synced_at: string | null = null;
  last_attempted_at: string | null = null;
  health: SourceHealth = 'never_synced';
  error_code: string | null = null;
  error_detail: string | null = null;
  consecutive_failures: number = 0;

  constructor(entity: Partial<IDataSourceCursor> = {}) {
    super(entity);
    this.data_source_id = entity.data_source_id ?? this.data_source_id;
    this.stream_key = entity.stream_key ?? this.stream_key;
    this.stream_label = entity.stream_label ?? this.stream_label;
    this.enabled = entity.enabled ?? this.enabled;
    this.high_water = entity.high_water ?? this.high_water;
    this.state = entity.state ?? this.state;
    this.last_synced_at = entity.last_synced_at ?? this.last_synced_at;
    this.last_attempted_at = entity.last_attempted_at ?? this.last_attempted_at;
    this.health = entity.health ?? this.health;
    this.error_code = entity.error_code ?? this.error_code;
    this.error_detail = entity.error_detail ?? this.error_detail;
    this.consecutive_failures = entity.consecutive_failures ?? this.consecutive_failures;
  }
}

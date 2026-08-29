/**
 * SourceItem — one ingested item of a DataSource
 * (flow_sdk/builtin/source_item.py). Read-mostly: the drivers write these;
 * the UI and editor apps list, star and mark them read.
 */
import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface ISourceItem extends IEntity {
  kind?: string;
  provider?: string;
  data_source_id?: string;
  segment_key?: string;
  segment_label?: string;
  external_id?: string;
  thread_key?: string | null;
  reply_to_external_id?: string | null;
  permalink?: string | null;
  occurred_at?: string | null;
  author_external_id?: string | null;
  author_display?: string | null;
  body?: string;
  read?: boolean;
  starred?: boolean;
}

@registerEntity
export class SourceItem extends APIEntity<SourceItem> implements ISourceItem {
  static type: string = 'source_item';

  kind: string = '';
  provider: string = '';
  data_source_id: string = '';
  segment_key: string = '';
  segment_label: string = '';
  external_id: string = '';
  thread_key: string | null = null;
  reply_to_external_id: string | null = null;
  permalink: string | null = null;
  occurred_at: string | null = null;
  author_external_id: string | null = null;
  author_display: string | null = null;
  body: string = '';
  read: boolean = false;
  starred: boolean = false;

  constructor(entity: Partial<ISourceItem> = {}) {
    super(entity);
    this.kind = entity.kind ?? this.kind;
    this.provider = entity.provider ?? this.provider;
    this.data_source_id = entity.data_source_id ?? this.data_source_id;
    this.segment_key = entity.segment_key ?? this.segment_key;
    this.segment_label = entity.segment_label ?? this.segment_label;
    this.external_id = entity.external_id ?? this.external_id;
    this.thread_key = entity.thread_key ?? this.thread_key;
    this.reply_to_external_id = entity.reply_to_external_id ?? this.reply_to_external_id;
    this.permalink = entity.permalink ?? this.permalink;
    this.occurred_at = entity.occurred_at ?? this.occurred_at;
    this.author_external_id = entity.author_external_id ?? this.author_external_id;
    this.author_display = entity.author_display ?? this.author_display;
    this.body = entity.body ?? this.body;
    this.read = entity.read ?? this.read;
    this.starred = entity.starred ?? this.starred;
  }
}

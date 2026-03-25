/**
 * ResourceRecordList — typed collection with CRUD via ActionInfo.
 * Mirrors Python `fs_store.resource_record_list.ResourceRecordList`.
 *
 * Parametrized by a concrete FsRecord class; all operations delegate to
 * the backend via `POST /fs_records/record_list_<op>`.
 */
import { ActionInfo } from '../../models/ActionInfo';
import { dataManager } from '../../APIEntity';
import type { FsRecordData } from './fs-record';
import { FsRecord } from './fs-record';
import type { StorageLayout } from './storage-layout';
import type { Scope } from './scope';

/** Constructor type for a concrete FsRecord subclass. */
type FsRecordClass<T extends FsRecord = FsRecord> = (new (data?: Partial<FsRecordData>) => T) & typeof FsRecord;

export class ResourceRecordList<T extends FsRecord = FsRecord> {
  private _recordClass: FsRecordClass<T>;
  private _computeNodeId: string;

  constructor(recordClass: FsRecordClass<T>, computeNodeId: string) {
    this._recordClass = recordClass;
    this._computeNodeId = computeNodeId;
  }

  get recordType(): string {
    return this._recordClass._recordType;
  }

  get storageLayout(): StorageLayout {
    return this._recordClass._storageLayout;
  }

  // ── CRUD operations ──────────────────────────────────────────

  /** Get a record by UID. */
  async get(uid: string): Promise<T | null> {
    const action = new ActionInfo('fs-records', 'compute_node', this._computeNodeId, 'POST');
    action.subpath = 'record_list_get';
    action.bodyParameters = { record_type: this.recordType, uid };
    const res = await dataManager.callAction<unknown, { data?: Record<string, unknown> | null }>(action);
    const d = (res?.data ?? res) as Record<string, unknown> | null;
    if (!d) return null;
    return new this._recordClass(d as Partial<FsRecordData>);
  }

  /** Create a new record. */
  async create(record: T): Promise<T> {
    const action = new ActionInfo('fs-records', 'compute_node', this._computeNodeId, 'POST');
    action.subpath = 'record_list_save';
    action.bodyParameters = { record_type: this.recordType, record: record.toDict() };
    const res = await dataManager.callAction<unknown, { data?: Record<string, unknown> }>(action);
    const d = (res?.data ?? res) as Record<string, unknown>;
    if (d) Object.assign(record, d);
    return record;
  }

  /** Save (upsert) an existing record. */
  async save(record: T): Promise<T> {
    return this.create(record);
  }

  /** Partial update by UID. */
  async update(uid: string, data: Partial<FsRecordData>): Promise<T | null> {
    const existing = await this.get(uid);
    if (!existing) return null;
    Object.assign(existing, data);
    return this.save(existing);
  }

  /** Delete a record by UID. */
  async delete(uid: string): Promise<boolean> {
    const action = new ActionInfo('fs-records', 'compute_node', this._computeNodeId, 'POST');
    action.subpath = 'record_list_delete';
    action.bodyParameters = { record_type: this.recordType, uid };
    const res = await dataManager.callAction<unknown, { data?: { deleted: boolean } }>(action);
    return (res?.data ?? (res as unknown as { deleted: boolean })).deleted ?? false;
  }

  /** List all records of this type. */
  async list(scope?: Scope | string): Promise<T[]> {
    const action = new ActionInfo('fs-records', 'compute_node', this._computeNodeId, 'POST');
    action.subpath = 'record_list_list';
    action.bodyParameters = { record_type: this.recordType, scope };
    const res = await dataManager.callAction<unknown, { data?: Record<string, unknown>[] }>(action);
    const items = (res?.data ?? res) as Record<string, unknown>[];
    if (!Array.isArray(items)) return [];
    return items.map((d) => new this._recordClass(d as Partial<FsRecordData>));
  }
}

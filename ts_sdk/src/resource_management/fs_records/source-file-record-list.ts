/**
 * SourceFileRecordList — reads a single JSON file and extracts typed records.
 * Mirrors Python `fs_store.source_file_record_list.SourceFileRecordList`.
 *
 * The backend reads the file, runs `_extract()` on the Python side, and
 * returns the extracted records as JSON.  The TypeScript side deserializes
 * into typed FsRecord instances.
 */
import { ActionInfo } from '../../models/ActionInfo';
import { dataManager } from '../../APIEntity';
import type { FsRecordData } from './fs-record';
import { FsRecord } from './fs-record';
import { fsRecordTypeRegistry } from './record-type-registry';

export class SourceFileRecordList {
  /** Override in subclasses to identify the list type sent to the backend. */
  static _listType = '';

  protected _records: FsRecord[] = [];
  protected _loaded = false;
  private _computeNodeId: string;
  private _sourcePath: string;

  constructor(computeNodeId: string, sourcePath = '') {
    this._computeNodeId = computeNodeId;
    this._sourcePath = sourcePath;
  }

  get records(): FsRecord[] {
    return this._records;
  }

  get loaded(): boolean {
    return this._loaded;
  }

  get sourcePath(): string {
    return this._sourcePath;
  }

  /** Load records from the backend. */
  async load(): Promise<FsRecord[]> {
    // Path-based API: use GET /fs-records/file?path=... when sourcePath is set
    if (this._sourcePath) {
      const action = new ActionInfo('fs-records', 'compute_node', this._computeNodeId, 'GET');
      action.subpath = `file?path=${encodeURIComponent(this._sourcePath)}`;
      const res = await dataManager.callAction<unknown, { data?: Record<string, unknown>[] }>(
        action,
      );
      const items = (res?.data ?? res) as Record<string, unknown>[];
      if (!Array.isArray(items)) {
        this._records = [];
        this._loaded = true;
        return this._records;
      }
      this._records = items.map((d) => this._deserializeRecord(d));
      this._loaded = true;
      return this._records;
    }

    // Legacy: POST source_file_load (kept for backward compat)
    const listType = (this.constructor as typeof SourceFileRecordList)._listType;
    const action = new ActionInfo('fs-records', 'compute_node', this._computeNodeId, 'POST');
    action.subpath = 'source_file_load';
    action.bodyParameters = { list_type: listType };
    const res = await dataManager.callAction<unknown, { data?: Record<string, unknown>[] }>(action);
    const items = (res?.data ?? res) as Record<string, unknown>[];
    if (!Array.isArray(items)) {
      this._records = [];
      this._loaded = true;
      return this._records;
    }
    this._records = items.map((d) => this._deserializeRecord(d));
    this._loaded = true;
    return this._records;
  }

  /** Update a record by json_path via the path-based API. */
  async updateRecord(jsonPath: string, data: Record<string, unknown>): Promise<FsRecord | null> {
    if (!this._sourcePath) {
      throw new Error('updateRecord requires a sourcePath');
    }
    const action = new ActionInfo('fs-records', 'compute_node', this._computeNodeId, 'PUT');
    action.subpath = `file?path=${encodeURIComponent(this._sourcePath)}&json_path=${encodeURIComponent(jsonPath)}`;
    action.bodyParameters = data;
    const res = await dataManager.callAction<unknown, { data?: Record<string, unknown> }>(action);
    const item = res?.data ?? res;
    if (!item || typeof item !== 'object') return null;
    const record = this._deserializeRecord(item as Record<string, unknown>);

    // Update local cache
    const idx = this._records.findIndex((r) => r.json_path === jsonPath);
    if (idx >= 0) {
      this._records[idx] = record;
    }

    return record;
  }

  /** Delete a record by json_path via the path-based API. */
  async deleteRecord(jsonPath: string): Promise<boolean> {
    if (!this._sourcePath) {
      throw new Error('deleteRecord requires a sourcePath');
    }
    const action = new ActionInfo('fs-records', 'compute_node', this._computeNodeId, 'DELETE');
    action.subpath = `file?path=${encodeURIComponent(this._sourcePath)}&json_path=${encodeURIComponent(jsonPath)}`;
    const res = await dataManager.callAction<unknown, { data?: Record<string, unknown> }>(action);
    const success = !!(res?.data as Record<string, unknown>)?.deleted;

    // Update local cache
    if (success) {
      this._records = this._records.filter((r) => r.json_path !== jsonPath);
    }

    return success;
  }

  /** Get a single record by type and UID. */
  get(type: string, uid: string): FsRecord | undefined {
    return this._records.find((r) => r.type === type && r.id === uid);
  }

  /** Get all records of a given type. */
  byType(type: string): FsRecord[] {
    return this._records.filter((r) => r.type === type);
  }

  /** Deserialize a raw record object into a typed FsRecord.
   *
   * Uses Object.assign post-construction to avoid the TypeScript class-field
   * initializer gotcha: subclass field initializers run AFTER super(data),
   * which would overwrite values set in the base constructor.
   */
  private _deserializeRecord(d: Record<string, unknown>): FsRecord {
    const recordType = d.type as string;
    const Ctor = fsRecordTypeRegistry.get(recordType);
    if (Ctor) {
      const instance = new Ctor();
      Object.assign(instance, d);
      return instance as unknown as FsRecord;
    }
    const instance = new FsRecord();
    Object.assign(instance, d);
    return instance;
  }
}

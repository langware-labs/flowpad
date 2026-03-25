/**
 * FsRecord — base class for all filesystem-backed records.
 * Mirrors Python `fs.fs_record.FsRecord` + `fs.fs_entity.FsEntity`.
 *
 * Design notes:
 * - FsRecord is NOT an APIEntity (it doesn't extend the DB-backed class).
 * - All I/O goes through ActionInfo → backend compute node.
 * - Field names are snake_case for Pydantic interop.
 */
import { ActionInfo } from '../../models/ActionInfo';
import { dataManager } from '../../APIEntity';
import type { IResource } from '../../IResource';
import type { ResourceRecord } from './resource-record';
import { Scope } from './scope';
import { StorageLayout } from './storage-layout';
import type { FsRecordRef } from './fs-record-ref';
import { ResourceStatus } from './resource-record';
import { recordStem } from './resource-record';

/** Plain-object shape that travels over the wire (JSON serializable). */
export interface FsRecordData extends ResourceRecord {
  [key: string]: unknown;
}

/**
 * Base class for all filesystem records.
 *
 * Concrete subclasses must set static `_recordType` and optionally override
 * `_readOnly` and `_storageLayout`. They should call
 * `fsRecordTypeRegistry.register(MyClass._recordType, MyClass)` at module level.
 */
export class FsRecord implements IResource {
  // ── Static metadata (override in subclasses) ─────────────────
  static _recordType = '';
  static _readOnly = false;
  static _storageLayout: StorageLayout = StorageLayout.FILE;

  // ── IResource fields ─────────────────────────────────────────
  id = '';
  type = '';
  name = '';
  created_at?: string;
  modified_at?: string;
  created_by?: string;
  updated_by?: string;

  // ── ResourceRecord extensions ────────────────────────────────
  status?: ResourceStatus;
  scope: Scope | string = Scope.USER;
  source_file?: string;
  path?: string;
  entity_id?: string;
  raw_json?: Record<string, unknown>;
  json_path?: string;
  children_refs?: FsRecordRef[];
  parent_ref?: FsRecordRef;
  origin_ref?: FsRecordRef;

  // ── Instance state (not serialized) ──────────────────────────
  private _computeNodeId?: string;

  constructor(data?: Partial<FsRecordData>) {
    if (data) {
      Object.assign(this, data);
    }
    const ctor = this.constructor as typeof FsRecord;
    if (!this.type && ctor._recordType) {
      this.type = ctor._recordType;
    }
  }

  // ── Computed properties ──────────────────────────────────────

  /** TypeId-style stem: `{type}-{id}`. */
  get stem(): string {
    return recordStem(this.type, this.id);
  }

  get recordType(): string {
    return (this.constructor as typeof FsRecord)._recordType;
  }

  get readOnly(): boolean {
    return (this.constructor as typeof FsRecord)._readOnly;
  }

  get storageLayout(): StorageLayout {
    return (this.constructor as typeof FsRecord)._storageLayout;
  }

  // ── Compute node binding ─────────────────────────────────────

  /** Bind this record to a backend compute node (required for CRUD). */
  setComputeNode(computeNodeId: string): void {
    this._computeNodeId = computeNodeId;
  }

  private get computeNodeId(): string {
    if (!this._computeNodeId) {
      throw new Error('FsRecord: computeNodeId not set — call setComputeNode() first');
    }
    return this._computeNodeId;
  }

  // ── Serialization ────────────────────────────────────────────

  /** Serialize to a plain dict (matches Python `model_dump()`). */
  toDict(): Record<string, unknown> {
    const d: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this)) {
      if (k.startsWith('_') || v === undefined) continue;
      d[k] = v;
    }
    return d;
  }

  /** Hydrate from a plain dict. */
  static fromDict<T extends FsRecord>(this: new (data?: Partial<FsRecordData>) => T, data: Record<string, unknown>): T {
    return new this(data as Partial<FsRecordData>);
  }

  // ── CRUD via ActionInfo → backend ────────────────────────────

  /** Persist this record to disk (create or update). */
  async save(): Promise<this> {
    if (this.readOnly) throw new Error(`${this.type} records are read-only`);
    const action = new ActionInfo('fs-records', 'compute_node', this.computeNodeId, 'POST');
    action.subpath = 'save';
    action.bodyParameters = this.toDict();
    const res = await dataManager.callAction<unknown, { data?: Record<string, unknown> }>(action);
    const saved = (res?.data ?? res) as Record<string, unknown>;
    if (saved) Object.assign(this, saved);
    return this;
  }

  /** Delete this record from disk. */
  async delete(): Promise<boolean> {
    if (this.readOnly) throw new Error(`${this.type} records are read-only`);
    const action = new ActionInfo('fs-records', 'compute_node', this.computeNodeId, 'POST');
    action.subpath = 'delete';
    action.bodyParameters = { type: this.type, id: this.id, scope: this.scope };
    const res = await dataManager.callAction<unknown, { data?: { deleted: boolean } }>(action);
    return (res?.data ?? (res as unknown as { deleted: boolean })).deleted ?? false;
  }

  /** Fetch a single record by ID. */
  static async getById<T extends FsRecord>(
    this: (new (data?: Partial<FsRecordData>) => T) & typeof FsRecord,
    computeNodeId: string,
    id: string,
    scope?: Scope | string,
  ): Promise<T | null> {
    const action = new ActionInfo('fs-records', 'compute_node', computeNodeId, 'POST');
    action.subpath = 'get_by_id';
    action.bodyParameters = { type: this._recordType, id, scope };
    const res = await dataManager.callAction<unknown, { data?: Record<string, unknown> | null }>(action);
    const d = (res?.data ?? res) as Record<string, unknown> | null;
    if (!d) return null;
    return new this(d as Partial<FsRecordData>);
  }

  /** Fetch all records of this type. */
  static async getAll<T extends FsRecord>(
    this: (new (data?: Partial<FsRecordData>) => T) & typeof FsRecord,
    computeNodeId: string,
    opts?: { scope?: Scope | string; limit?: number; offset?: number; filters?: Record<string, unknown> },
  ): Promise<T[]> {
    const action = new ActionInfo('fs-records', 'compute_node', computeNodeId, 'POST');
    action.subpath = 'get_all';
    action.bodyParameters = { type: this._recordType, ...opts };
    const res = await dataManager.callAction<unknown, { data?: Record<string, unknown>[] }>(action);
    const items = (res?.data ?? res) as Record<string, unknown>[];
    if (!Array.isArray(items)) return [];
    return items.map((d) => new this(d as Partial<FsRecordData>));
  }
}

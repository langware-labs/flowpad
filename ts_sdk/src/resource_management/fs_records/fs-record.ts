/**
 * FsRecord — base class for all filesystem-backed records.
 * Mirrors Python `fs.fs_record.FsRecord` + `fs.fs_entity.FsEntity`.
 *
 * Design notes:
 * - FsRecord is NOT an APIEntity (it doesn't extend the DB-backed class).
 * - Reads go through SourceFileRecordList → the backend compute node.
 * - Field names are snake_case for Pydantic interop.
 */
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

  // No CRUD helpers here. The backend routes /fs-records/<segment> by RECORD
  // TYPE, so the save/delete/get_by_id/get_all subpaths these used to POST were
  // answered with 400 "Unknown record type 'save'". Records are read through
  // SourceFileRecordList and written through its updateRecord().
}

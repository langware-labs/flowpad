/**
 * fs_records barrel — re-exports all fs_store base types + Claude record types.
 */

// ── Base types / enums ─────────────────────────────────
// NOTE: Scope is NOT re-exported here to avoid clashing with the existing
// `Scope` enum from `entities/compute-node/system-profile`.  Import it
// directly from `resource_management/fs_records/scope` when needed.
export { Scope as FsScope } from './scope';
export { StorageLayout } from './storage-layout';
export { RecordType } from './record-types';
export { type FsRecordRef, fsRecordRefToDict, fsRecordRefFromDict } from './fs-record-ref';
export {
  ResourceStatus,
  type ResourceRecord,
  recordStem,
  parseRecordStem,
  resourceRecordToDict,
  resourceRecordFromDict,
} from './resource-record';

// ── Registry ───────────────────────────────────────────
export { RecordTypeRegistry, fsRecordTypeRegistry, type FsRecordConstructor } from './record-type-registry';

// ── FsRecord base class ────────────────────────────────
export { FsRecord, type FsRecordData } from './fs-record';

// ── Collection classes ─────────────────────────────────
export { SourceFileRecordList } from './source-file-record-list';

// ── DataOp handler ─────────────────────────────────────
export {
  subscribeFsRecord,
  subscribeFsRecordAll,
  subscribeFsRecordByFile,
  type FsDataOpType,
  type FsDataOpEvent,
  type FsDataOpCallback,
} from './data-op-handler';

// ── Claude record types ────────────────────────────────
export * from './claude/index';

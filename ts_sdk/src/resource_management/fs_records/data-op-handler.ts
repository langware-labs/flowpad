/**
 * FsRecordDataOpHandler — listens for DataOp messages and dispatches
 * to per-record-type subscribers.
 *
 * After save/delete the backend broadcasts:
 *   DataOpMessage(to_entity=`{type}-@{uid}`, op="update"|"create"|"delete", data={...})
 *
 * This module matches the `type` portion against the RecordTypeRegistry
 * and dispatches to any registered callbacks.
 */
import { ConnectionManager } from '../../websocket';
import { fsRecordTypeRegistry } from './record-type-registry';
import type { FsRecordData } from './fs-record';

export type FsDataOpType = 'create' | 'update' | 'delete';

export interface FsDataOpEvent {
  recordType: string;
  id: string;
  op: FsDataOpType;
  data?: Partial<FsRecordData>;
  /** Source file path when the event came from the path-based API. */
  sourceFile?: string;
}

export type FsDataOpCallback = (event: FsDataOpEvent) => void;

/** Per-type subscriber lists. */
const _subscribers = new Map<string, Set<FsDataOpCallback>>();

/** Wildcard subscribers (receive all record-type events). */
const _wildcardSubscribers = new Set<FsDataOpCallback>();

/** Per-source-file subscriber lists. */
const _sourceFileSubscribers = new Map<string, Set<FsDataOpCallback>>();

/** Whether we've attached the ConnectionManager listener. */
let _attached = false;

/**
 * Handle an incoming data_op_msg and dispatch to subscribers.
 * Expected `to_entity` format: `{recordType}-@{uid}` or `{recordType}-{uuid}`.
 */
function handleDataOp(toEntity: string, op: string, data?: Record<string, unknown>): void {
  // Parse record type from the entity identifier
  const dashIdx = toEntity.indexOf('-');
  if (dashIdx < 0) return;
  const recordType = toEntity.slice(0, dashIdx);

  // Only dispatch for known fs-record types
  if (!fsRecordTypeRegistry.has(recordType)) return;

  const id = toEntity.slice(dashIdx + 1);

  // Extract _source_file from data payload if present
  const sourceFile = data?._source_file as string | undefined;

  const event: FsDataOpEvent = {
    recordType,
    id,
    op: op as FsDataOpType,
    data: data as Partial<FsRecordData> | undefined,
    sourceFile,
  };

  // Dispatch to type-specific subscribers
  const subs = _subscribers.get(recordType);
  if (subs) {
    for (const cb of subs) cb(event);
  }

  // Dispatch to source-file-specific subscribers
  if (sourceFile) {
    const fileSubs = _sourceFileSubscribers.get(sourceFile);
    if (fileSubs) {
      for (const cb of fileSubs) cb(event);
    }
  }

  // Dispatch to wildcard subscribers
  for (const cb of _wildcardSubscribers) cb(event);
}

/** Ensure we're listening on the ConnectionManager (idempotent). */
function ensureAttached(): void {
  if (_attached) return;
  _attached = true;
  const cm = ConnectionManager.getInstance();
  cm.on('on_data_op', (toEntity: string, op: string, data?: Record<string, unknown>) => {
    handleDataOp(toEntity, op, data);
  });
}

/**
 * Subscribe to DataOp events for a specific record type.
 * Returns an unsubscribe function.
 */
export function subscribeFsRecord(recordType: string, callback: FsDataOpCallback): () => void {
  ensureAttached();
  let subs = _subscribers.get(recordType);
  if (!subs) {
    subs = new Set();
    _subscribers.set(recordType, subs);
  }
  subs.add(callback);
  return () => {
    subs.delete(callback);
    if (subs.size === 0) _subscribers.delete(recordType);
  };
}

/**
 * Subscribe to DataOp events for ALL fs-record types.
 * Returns an unsubscribe function.
 */
export function subscribeFsRecordAll(callback: FsDataOpCallback): () => void {
  ensureAttached();
  _wildcardSubscribers.add(callback);
  return () => {
    _wildcardSubscribers.delete(callback);
  };
}

/**
 * Subscribe to DataOp events for a specific source file path.
 * Only events from the path-based API that include `_source_file` will match.
 * Returns an unsubscribe function.
 */
export function subscribeFsRecordByFile(sourceFile: string, callback: FsDataOpCallback): () => void {
  ensureAttached();
  let subs = _sourceFileSubscribers.get(sourceFile);
  if (!subs) {
    subs = new Set();
    _sourceFileSubscribers.set(sourceFile, subs);
  }
  subs.add(callback);
  return () => {
    subs.delete(callback);
    if (subs.size === 0) _sourceFileSubscribers.delete(sourceFile);
  };
}

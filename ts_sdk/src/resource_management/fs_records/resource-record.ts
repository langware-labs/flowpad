/**
 * ResourceRecord — mirrors Python `resource_management.api.ResourceRecord`.
 * Base interface for all filesystem-backed records (extends IResource).
 */
import type { IResource } from '../../IResource';
import type { Scope } from './scope';
import type { FsRecordRef } from './fs-record-ref';

/** Lifecycle status of a record. */
export enum ResourceStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
  DELETED = 'deleted',
}

/**
 * ResourceRecord extends IResource with filesystem-specific fields.
 * All field names use snake_case to match Python `to_dict()` output.
 */
export interface ResourceRecord extends IResource {
  /**
   * Whatever `status` this record's own indexer wrote — the WIRE shape of the
   * field, so per record type.
   *
   * Not `ResourceStatus`: that union is the archived/deleted lifecycle, and the
   * indexer writes other vocabularies into this key (e.g.
   * `fs_store/indexer/functions/claude_sessions.py:406` writes `"complete"`, a
   * run state). `FsRecord` types it the same way and subclasses narrow to their
   * own union — this shape is `FsRecord`'s CONSTRUCTOR parameter, so leaving it
   * as the enum made `new ClaudeSessionRecord({ status: 'complete' })` an error
   * even after the class allowed it. `ResourceStatus` remains the vocabulary a
   * lifecycle-owning record narrows to.
   */
  status?: string;

  /** Storage scope */
  scope: Scope | string;

  /** Absolute path to the JSON source file */
  source_file?: string;

  /** Absolute path to the record's directory or file */
  path?: string;

  /** Cloud entity ID for synced records */
  entity_id?: string;

  /** Raw JSON blob (extra / untyped data) */
  raw_json?: Record<string, unknown>;

  /** JSON-path within a multi-record source file */
  json_path?: string;

  /** References to child records */
  children_refs?: FsRecordRef[];

  /** Reference to parent record */
  parent_ref?: FsRecordRef;

  /** Reference to origin record (e.g. template this was cloned from) */
  origin_ref?: FsRecordRef;
}

/**
 * Derive a "stem" identifier from a record's type and id.
 * Format: `{type}-{id}` (matches Python `type_id_str`).
 */
export function recordStem(type: string, id: string): string {
  return `${type}-${id}`;
}

/**
 * Parse a stem string back into { type, id }.
 * Returns null if the stem does not contain a hyphen. Tolerates the legacy
 * `{type}-@{id}` shape (retired uname-sigil separator) by stripping a leading
 * `@` off the id — parity with Python `parse_record_stem`.
 */
export function parseRecordStem(stem: string): { type: string; id: string } | null {
  const idx = stem.indexOf('-');
  if (idx < 0) return null;
  let id = stem.slice(idx + 1);
  if (id.startsWith('@')) id = id.slice(1); // legacy {type}-@{id}
  return { type: stem.slice(0, idx), id };
}

/** Convert a ResourceRecord (or partial) to a plain dict. */
export function resourceRecordToDict(record: Partial<ResourceRecord>): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (v !== undefined) d[k] = v;
  }
  return d;
}

/** Hydrate a plain dict into a partial ResourceRecord. */
export function resourceRecordFromDict(data: Record<string, unknown>): Partial<ResourceRecord> {
  return data as Partial<ResourceRecord>;
}

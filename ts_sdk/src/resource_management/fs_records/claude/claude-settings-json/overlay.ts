/**
 * Overlay logic for merging Claude settings FsRecords across scopes.
 *
 * The overlay pattern: lower-scope records provide defaults, higher-scope
 * records override non-default values.  Precedence: local > project > user.
 */
import { FsRecord, type FsRecordData } from '../../fs-record';
import type { ClaudeSettingsJsonRecordList } from './index';
import { ClaudeSettingsJsonFsRecord } from './base';
import { ClaudePermissionsFsRecord } from './permissions';
import { ClaudeSandboxFsRecord } from './sandbox';
import { ClaudeAttributionFsRecord } from './attribution';

// ── Helpers ──────────────────────────────────────────────

/**
 * Create an FsRecord instance and assign data AFTER construction.
 *
 * Class field initializers in subclasses run after `super(data)`, so passing
 * data to the constructor gets overwritten by field defaults.  This helper
 * creates a default instance first, then applies data via Object.assign.
 */
function createRecord<T extends FsRecord>(
  RecordClass: new (data?: Partial<FsRecordData>) => T,
  data?: Record<string, unknown>,
): T {
  const inst = new RecordClass();
  if (data) Object.assign(inst, data);
  return inst;
}

/** Get a class-default instance for comparison. */
function getDefaults<T extends FsRecord>(
  RecordClass: new (data?: Partial<FsRecordData>) => T,
): Record<string, unknown> {
  const inst = new RecordClass();
  const defaults: Record<string, unknown> = {};
  for (const key of Object.keys(inst)) {
    if (key.startsWith('_')) continue;
    defaults[key] = (inst as Record<string, unknown>)[key];
  }
  return defaults;
}

/** Deep-equal for primitives, arrays, and plain objects. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
    for (const k of keys) {
      if (!deepEqual(aObj[k], bObj[k])) return false;
    }
    return true;
  }
  return false;
}

/** Shallow-merge two plain objects (for dict/env fields). */
function mergeDicts(
  lower: Record<string, unknown>,
  higher: Record<string, unknown>,
): Record<string, unknown> {
  return { ...lower, ...higher };
}

// ── overlayRecord ────────────────────────────────────────

/**
 * Overlay two FsRecord instances.  Higher-scope values win over lower-scope
 * defaults.  Returns a new instance with merged properties.
 *
 * For each own property on the record class:
 * - If `higher` has a value that differs from the class default, use it.
 * - Otherwise, use `lower`'s value.
 * - Dict/object fields are shallow-merged (higher keys win).
 */
export function overlayRecord<T extends FsRecord>(
  lower: T | undefined,
  higher: T | undefined,
  RecordClass: new (data?: Partial<FsRecordData>) => T,
): T {
  if (!lower && !higher) return new RecordClass();
  if (!lower) return createRecord(RecordClass, (higher as FsRecord).toDict());
  if (!higher) return createRecord(RecordClass, (lower as FsRecord).toDict());

  const defaults = getDefaults(RecordClass);
  const merged: Record<string, unknown> = {};

  for (const key of Object.keys(defaults)) {
    const lowerVal = (lower as Record<string, unknown>)[key];
    const higherVal = (higher as Record<string, unknown>)[key];
    const defaultVal = defaults[key];

    const higherIsDefault = deepEqual(higherVal, defaultVal);

    if (!higherIsDefault) {
      // Higher has a non-default value
      // For dict/object fields, merge with lower
      if (
        typeof higherVal === 'object' &&
        higherVal !== null &&
        !Array.isArray(higherVal) &&
        typeof lowerVal === 'object' &&
        lowerVal !== null &&
        !Array.isArray(lowerVal)
      ) {
        merged[key] = mergeDicts(
          lowerVal as Record<string, unknown>,
          higherVal as Record<string, unknown>,
        );
      } else {
        merged[key] = higherVal;
      }
    } else {
      // Higher is at default — use lower's value
      merged[key] = lowerVal;
    }
  }

  return createRecord(RecordClass, merged);
}

// ── overlaySettingsLists ─────────────────────────────────

export interface OverlayResult {
  root: ClaudeSettingsJsonFsRecord | undefined;
  permissions: ClaudePermissionsFsRecord | undefined;
  sandbox: ClaudeSandboxFsRecord | undefined;
  attribution: ClaudeAttributionFsRecord | undefined;
}

/**
 * Overlay multiple ClaudeSettingsJsonRecordLists (user < project < local).
 * Returns merged sub-records with full scope precedence applied.
 */
export function overlaySettingsLists(
  user: ClaudeSettingsJsonRecordList | null,
  project: ClaudeSettingsJsonRecordList | null,
  local: ClaudeSettingsJsonRecordList | null,
): OverlayResult {
  const mergeSubRecord = <T extends FsRecord>(
    getter: (list: ClaudeSettingsJsonRecordList) => T | undefined,
    Cls: new (data?: Partial<FsRecordData>) => T,
  ): T | undefined => {
    const u = user ? getter(user) : undefined;
    const p = project ? getter(project) : undefined;
    const l = local ? getter(local) : undefined;

    // user < project < local
    let result = overlayRecord(u, p, Cls);
    result = overlayRecord(result, l, Cls);
    return result;
  };

  return {
    root: mergeSubRecord(
      (list) => list.root,
      ClaudeSettingsJsonFsRecord,
    ),
    permissions: mergeSubRecord(
      (list) => list.permissions,
      ClaudePermissionsFsRecord,
    ),
    sandbox: mergeSubRecord(
      (list) => list.sandbox,
      ClaudeSandboxFsRecord,
    ),
    attribution: mergeSubRecord(
      (list) => list.attribution,
      ClaudeAttributionFsRecord,
    ),
  };
}

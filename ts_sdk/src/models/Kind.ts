/**
 * Open dot-kind ontology shared by entities that need hierarchical kinds.
 *
 * COMPAT SHIM — the grammar now lives in `tags/grammar.ts` (one
 * dot-taxonomy for kinds, bus tags, and capabilities). These names keep
 * their exact historical behavior (normalize throws on invalid input); new
 * code should import from `tags/grammar` directly. Kept until the Phase-5
 * importer migration retires this module.
 */
import {
  TAG_PATTERN,
  normalizeTag,
  tagAncestors,
  tagIsWithin,
  tryTag,
} from '../tags/grammar';

export const KIND_PATTERN = TAG_PATTERN;

/** A small starter vocabulary, not a closed set of allowed Artifact kinds. */
export const ARTIFACT_KINDS = {
  APPLICATION_WEB: 'application.web',
  WORKLOAD_SERVICE_HTTP: 'workload.service.http',
  WORKLOAD_JOB: 'workload.job',
  RESOURCE_DATABASE_POSTGRESQL: 'resource.database.postgresql',
  RESOURCE_QUEUE: 'resource.queue',
  RESOURCE_STORAGE_OBJECT: 'resource.storage.object',
  CONTENT_FILE: 'content.file',
  CONTENT_DATA: 'content.data',
} as const;

export type CoreArtifactKind = (typeof ARTIFACT_KINDS)[keyof typeof ARTIFACT_KINDS];

/** Normalize a kind for storage and reject values outside the dot grammar. */
export function normalizeKind(value: string): string {
  if (typeof value !== 'string') {
    throw new Error('kind must be a string');
  }
  try {
    return normalizeTag(value);
  } catch {
    throw new Error(`Invalid kind: ${value}`);
  }
}

/** True when a value can be normalized into a valid dot kind. */
export function isValidKind(value: unknown): value is string {
  return tryTag(value) !== null;
}

/** Exact-or-descendant match; `workload` matches `workload.service.http`. */
export function kindMatches(queryKind: string, candidateKind: string): boolean {
  return tagIsWithin(normalizeKind(candidateKind), normalizeKind(queryKind));
}

/**
 * Return ancestors from broadest to narrowest. Pass `includeSelf` to append
 * the normalized kind itself. Mirrors Python `kind_ancestors` exactly.
 */
export function kindAncestors(kind: string, includeSelf = false): string[] {
  return tagAncestors(normalizeKind(kind), includeSelf);
}

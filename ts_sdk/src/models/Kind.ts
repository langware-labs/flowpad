/**
 * Open dot-kind ontology shared by entities that need hierarchical kinds.
 *
 * Kinds are deliberately strings, not an enum: providers and plugins may add
 * descendants without requiring an SDK release.  This module is the one place
 * that owns normalization, validation, matching, and ancestor expansion so
 * Artifact, Deployment, and Capability do not grow subtly different rules.
 */
export const KIND_PATTERN = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;

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
  const normalized = value.trim().toLowerCase();
  if (!KIND_PATTERN.test(normalized)) {
    throw new Error(`Invalid kind: ${value}`);
  }
  return normalized;
}

/** True when a value can be normalized into a valid dot kind. */
export function isValidKind(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    normalizeKind(value);
    return true;
  } catch {
    return false;
  }
}

/** Exact-or-descendant match; `workload` matches `workload.service.http`. */
export function kindMatches(queryKind: string, candidateKind: string): boolean {
  const query = normalizeKind(queryKind);
  const candidate = normalizeKind(candidateKind);
  return candidate === query || candidate.startsWith(`${query}.`);
}

/**
 * Return ancestors from broadest to narrowest. Pass `includeSelf` to append
 * the normalized kind itself. Mirrors Python `kind_ancestors` exactly.
 */
export function kindAncestors(kind: string, includeSelf = false): string[] {
  const segments = normalizeKind(kind).split('.');
  const count = includeSelf ? segments.length : segments.length - 1;
  return Array.from({ length: count }, (_, index) => segments.slice(0, index + 1).join('.'));
}

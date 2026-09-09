/**
 * The project manifest's read contract — what a project has PUBLISHED, as the
 * backend's `GET project/<id>/published` (and the hub's equivalent) return it.
 * Mirrors the docstring of `flow_sdk/assets/project_manifest.py`; the shape is
 * the backend's, this file only names it.
 */

/** The types a manifest row may name in phase 1 (mirrors `PUBLISHABLE_TYPES`). */
export const PUBLISHABLE_TYPES = ['skill', 'subagent', 'markdown', 'mcp'] as const;
export type PublishableType = (typeof PUBLISHABLE_TYPES)[number];

export function isPublishableType(type: string | undefined | null): type is PublishableType {
  return !!type && (PUBLISHABLE_TYPES as readonly string[]).includes(type);
}

/**
 * What a reader can say about one published row.
 * - `in_use`: the carrier is here and indexed (hub: the path exists in the tree)
 * - `install`: on disk, no local row yet (pulled via git, not indexed) — desk only
 * - `stale`: the carrier is newer than the row's `published_at` — desk only
 * - `missing`: named by the manifest, gone from disk
 */
export type PublishedState = 'in_use' | 'install' | 'stale' | 'missing';

/** The fields every manifest-derived row shares — a `PublishedAssetSpec` as JSON. */
export interface PublishedRowBase {
  typeid: string;
  name: string;
  description: string;
  rel_path: string;
  published_at: string;
  /** WHERE the bytes can be fetched (a GitOrigin or LocalOrigin document); null for a row published without one. */
  origin?: Record<string, unknown> | null;
}

export interface PublishedRow extends PublishedRowBase {
  type: string;
  id: string;
  state: PublishedState;
  /** Absolute path when the carrier is on this machine; desk only. */
  posix_path?: string | null;
  /** Whether a local entity row exists; desk only. */
  indexed?: boolean;
}

export interface UnpublishedRow {
  typeid: string;
  type: string;
  name: string;
  posix_path: string | null;
  project_id: string | null;
}

export interface PublishedManifestInfo {
  exists: boolean;
  schema: number | null;
  requires: Record<string, string>;
  rel_path: string;
  /** `project_manifest-<uuid>` once the manifest itself is indexed. */
  typeid: string | null;
}

export interface PublishedView {
  manifest: PublishedManifestInfo;
  rows: PublishedRow[];
  /** Assets inside the project that could still be published. `[]` on the hub. */
  unpublished: UnpublishedRow[];
}

/** A project with no manifest (or no project at all), as the read model says it. */
export const EMPTY_PUBLISHED_VIEW: PublishedView = {
  manifest: { exists: false, schema: null, requires: {}, rel_path: '', typeid: null },
  rows: [],
  unpublished: [],
};

/** What the hub relays to a logged-in desktop when a user clicks Install. */
export interface InstallRequest extends PublishedRowBase {
  request_id?: string;
  type: string;
  origin: Record<string, unknown> | null;
  source_project_id: string;
  source_project_name: string;
}

/** One row of `deps.json` — a published row plus provenance. */
export interface DependencyRow extends PublishedRowBase {
  origin: Record<string, unknown> | null;
  source_project_id: string;
  source_project_name: string;
  installed_at: string;
}

export interface InstallPublishedResult {
  installed: DependencyRow;
  /** The DisplayTarget to open after the install (entity target, or a setup session). */
  show: Record<string, unknown> | null;
  posix_path: string;
  id: string;
}

export interface RequestInstallResult {
  /** How many logged-in desktops received the request; 0 ⇒ show the install snippet. */
  delivered: number;
  request_id: string;
}

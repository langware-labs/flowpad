/**
 * The wire shape of a project row, separate from the Project class that hydrates it.
 * See the layering rule in `entities/compute-node/compute-node-types.ts`.
 */
import type { IEntity } from '../IEntity';
import type { GitOrigin } from '../models/GitOrigin';
import type { ConversationParticipant } from './conversation';

export interface ProjectMember {
  member_id: string;
  name: string;
  joined_at: string | null;
  last_seen_at: string | null;
}

/** Mirror of the backend computed `Project.context_dir_infos` entries — one per
 *  RESOLVED dependency (a dependency with a local folder). */
export interface ProjectContextDirInfo {
  path: string;
  /** Origin kind stamped at link time — "git" for cloned repos, else "local". */
  origin_kind: string;
  /** The linked Folder entity's typeid (e.g. "folder-<uuid>") — referenced by
   *  UI surfaces like the push-notify message chip. Empty for legacy dirs. */
  typeid?: string;
  /** The `flow.json` dependency name this folder resolves; empty for a legacy link. */
  dependency?: string;
  /** False for an `optionalDependencies` entry. */
  required?: boolean;
  /** The dependency that declared this one, for a transitive dependency; else empty. */
  via?: string;
}

/** Where a declared dependency stands on THIS machine. */
export type DependencyStateName = 'ready' | 'missing' | 'unreachable' | 'not_installed' | 'invalid' | 'not_found';

/** Mirror of the backend `DependencyState` — one `flow.json` dependency as it
 *  stands here. What every dependency action answers. */
export interface DependencyState {
  name: string;
  /** As declared: an id (`<type>-<uuid>` / `<kind>.id.<uuid>`), or — in a project's own
   *  file — `git+<url>#<branch>`, `hub:<project-id>`, `file:<path>`. */
  source: string;
  /** False for an `optionalDependencies` entry — fetched only on install. */
  required: boolean;
  /** The sub-folder of the source the dependency points at; "." for its root. */
  path: string;
  state: DependencyStateName;
  /** The resolved local folder (`ready` only). */
  local_path?: string | null;
  /** Why it is not ready, or a note on a ready one (a branch mismatch). */
  reason?: string | null;
  /** The dependency that declared it, for one reached transitively; null = this project. */
  via?: string | null;
  /** Every hop from the project to this one: the dependencies on the way, or the project's own
   *  asset (`data_source/<name>`) that declared it. Empty for the project's own file. */
  via_path?: string[];
  /** The TypeId an id entry resolved to. */
  typeid?: string | null;
  /** The entry's human-friendly name and description. */
  label?: string | null;
  description?: string | null;
  /** A required, not-ready dependency whose warning was dismissed until the next restart. */
  dismissed: boolean;
}

/** A project's visual identity, from the `brand` block of
 *  `.flow/customization/string.json`. Every field is optional; the block itself
 *  is null unless at least one survived validation.
 *
 *  `logo` / `logo_dark` are REPO-RELATIVE paths the backend has already
 *  confirmed exist and are inside the project root — hand them straight to
 *  `useFS(projectTypeId).getDownloadUrl(path)`, no probe needed. */
export interface ProjectBrand {
  name?: string | null;
  tagline?: string | null;
  /** CSS colour for the accent. Apply it SCOPED to the branded container, never
   *  to `documentElement` — see `useHelpdeskBrand`. */
  accent?: string | null;
  logo?: string | null;
  logo_dark?: string | null;
}

/** Optional per-project branding read from `.flow/customization/`.
 *  Mirrors the backend `Project.customization` computed field. Image bytes are
 *  fetched on demand via the `fs` download action; here only a flag (home
 *  background) or a relative path (brand logos). */
export interface ProjectCustomization {
  /** From `.flow/customization/string.json` — overrides the home greeting. */
  home_title?: string | null;
  /** True when `.flow/customization/home.png` exists → render it as background. */
  has_home_background?: boolean;
  /** Null when the project ships no usable brand block. */
  brand?: ProjectBrand | null;
}

export interface IProject extends IEntity {
  /** Hub role roster — the generic `members` cache from the Entity base. */
  members?: ConversationParticipant[];
  /** Portable repository identity; the hub sends it under its wire name `git_origin`. */
  origin?: GitOrigin | null;
  git_origin?: GitOrigin | null;
  hub_published_at?: string | null;
  last_mode?: string | null;
  locale?: string | null;
  session_code?: string | null;
  host_member_id?: string | null;
  presence?: ProjectMember[];
  include_dirs?: string[];
  context_roots?: string[];
  context_dir_infos?: ProjectContextDirInfo[];
  customization?: ProjectCustomization;
  hidden?: boolean;
  folder_name_mismatch?: string | null;
}

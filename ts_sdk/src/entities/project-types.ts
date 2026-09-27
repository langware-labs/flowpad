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

/** Mirror of the backend computed `Project.context_dir_infos` entries. */
export interface ProjectContextDirInfo {
  path: string;
  /** Origin kind stamped at link time — "git" for cloned repos, else "local". */
  origin_kind: string;
  /** The linked Folder entity's typeid (e.g. "folder-<uuid>") — referenced by
   *  UI surfaces like the push-notify message chip. Empty for legacy dirs. */
  typeid?: string;
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
}

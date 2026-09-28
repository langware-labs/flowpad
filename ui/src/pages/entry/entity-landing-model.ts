import { type GitOrigin, PageId, TypeId, ViewType } from '@sdk';
import { gitOriginCloneUrl, gitOriginOf, isCompleteGitOrigin } from '@sdk/models/GitOrigin';
import { errorStatus } from '@src/lib/error-message';
import { DockPointer } from '@src/navigation/DockPointer';

/**
 * The generic landing for `/<type>/<id>` — the URL the hub's
 * `_post_accept_landing_url` emits when an invitation carries no
 * `callback_override`. Type-specific destinations are the sharing client's job
 * (it sets the override); this page is the default for every type, so nothing
 * in this module branches on the type name. Its inputs are the route params, the
 * hub's TypeInfo for the type, and the entity row.
 */

/** The route params as a TypeId, or null when they cannot form one. */
export function parseEntityLandingParams(type: string | undefined, id: string | undefined): TypeId | null {
  if (!type || !id) return null;
  try {
    return new TypeId(type, id);
  } catch {
    return null;
  }
}

export type EntityLandingProblem = 'not-found' | 'signed-out' | 'failed';

/**
 * Why the entity could not be shown, or null when nothing went wrong.
 *
 * `not-found` covers "no such entity" and "not yours to see" together: the hub
 * answers both with 403 `target_not_found`, so the page cannot tell them apart
 * and must not pretend to. 422 is the hub rejecting an unknown type or a
 * malformed id, which from here is the same dead link.
 */
export function entityLandingProblem(state: { notFound: boolean; error: unknown }): EntityLandingProblem | null {
  if (state.notFound) return 'not-found';
  if (!state.error) return null;
  const status = errorStatus(state.error);
  if (status === 401) return 'signed-out';
  if (status === 403 || status === 404 || status === 422) return 'not-found';
  return 'failed';
}

/** The hub's generic entity view for a TypeId: `/dock/hub/entity/<type>/<id>`. */
export function hubEntityUrl(typeId: TypeId): string {
  return new DockPointer(ViewType.HUB_ENTITY, `${typeId.type}/${typeId.id}`, undefined, undefined, PageId.HUB).toUrl();
}

export interface EntityLandingInput {
  typeId: TypeId;
  /** `TypeInfo.cloud_file_transport` from the hub bootstrap registry. */
  cloudFileTransport?: string | null;
  displayName: string;
  description?: string | null;
  gitOrigin?: GitOrigin | null;
}

export interface EntityLandingModel {
  displayName: string;
  description: string | null;
  hubUrl: string;
  /** Show the "work on it on your machine" card: the entity carries a git origin,
   *  or its type ships its files through git. Types with neither (task,
   *  whiteboard, trigger today) fall back to the browser card alone. */
  showDesktop: boolean;
  /** Present only when there is a concrete repository to clone. */
  cloneCommand: string | null;
  /** Repo-relative path of the entity inside that repository, when not the root. */
  repoPath: string | null;
}

export function entityLandingModel(input: EntityLandingInput): EntityLandingModel {
  const origin = isCompleteGitOrigin(input.gitOrigin) ? input.gitOrigin : null;
  const branch = origin?.branch ? `-b ${origin.branch} ` : '';
  return {
    displayName: input.displayName,
    description: input.description?.trim() || null,
    hubUrl: hubEntityUrl(input.typeId),
    showDesktop: !!origin || input.cloudFileTransport === 'git',
    cloneCommand: origin ? `git clone ${branch}${gitOriginCloneUrl(origin)}` : null,
    repoPath: origin && origin.rel_path && origin.rel_path !== '.' ? origin.rel_path : null,
  };
}

/** Read the landing's inputs off whatever entity row the hub returned. */
export function entityLandingInputFrom(
  typeId: TypeId,
  entity: { displayName?: string; description?: unknown; origin?: GitOrigin | null; git_origin?: GitOrigin | null },
  cloudFileTransport: string | null | undefined,
): EntityLandingInput {
  return {
    typeId,
    cloudFileTransport,
    displayName: entity.displayName || typeId.id,
    description: typeof entity.description === 'string' ? entity.description : null,
    gitOrigin: gitOriginOf(entity),
  };
}

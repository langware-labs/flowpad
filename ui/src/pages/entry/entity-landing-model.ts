import { type GitOrigin, TypeId } from '@sdk';
import { gitOriginOf, isInstallableOrigin } from '@sdk/models/GitOrigin';
import { errorStatus } from '@src/lib/error-message';
import { hubEntityDock } from '@src/lib/hub-page-url';

/**
 * View model for the generic `/<type>/<id>` landing (`EntityLanding`). Type-blind
 * by design: every value comes from the route params, the hub's TypeInfo and the
 * entity row — never from which type it is.
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

/**
 * Why the entity could not be shown, or null when nothing went wrong.
 *
 * `not-found` covers "no such entity" and "not yours to see" together: the hub
 * answers both with 403 `target_not_found`, so the page cannot tell them apart
 * and must not pretend to. 422 is the hub rejecting a type or id this client's
 * registry accepted — from here, the same dead link.
 */
export function entityLandingProblem(state: {
  notFound: boolean;
  error: unknown;
}): 'not-found' | 'signed-out' | 'failed' | null {
  if (state.notFound) return 'not-found';
  if (!state.error) return null;
  const status = errorStatus(state.error);
  if (status === 401) return 'signed-out';
  if (status === 403 || status === 404 || status === 422) return 'not-found';
  return 'failed';
}

export interface EntityLandingModel {
  displayName: string;
  description: string | null;
  hubUrl: string;
  /** The repository the entity lives in, when it names one a checkout can be made from. */
  gitOrigin: GitOrigin | null;
  /** Offer the "work on it on your machine" card: the entity carries a git origin,
   *  or its type ships its files through git. */
  showDesktop: boolean;
}

export function entityLandingModel(
  typeId: TypeId,
  entity: { displayName?: string; description?: unknown; origin?: GitOrigin | null; git_origin?: GitOrigin | null },
  cloudFileTransport?: string | null,
): EntityLandingModel {
  const origin = gitOriginOf(entity);
  const gitOrigin = isInstallableOrigin(origin) ? origin : null;
  return {
    displayName: entity.displayName || typeId.id,
    description: typeof entity.description === 'string' ? entity.description.trim() || null : null,
    hubUrl: hubEntityDock(typeId.type, typeId.id).toUrl(),
    gitOrigin,
    showDesktop: !!gitOrigin || cloudFileTransport === 'git',
  };
}

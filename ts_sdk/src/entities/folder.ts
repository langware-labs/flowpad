import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity, EntityMerge } from '../IEntity';
import type { GitOrigin } from '../models/GitOrigin';

export interface IFolder extends IEntity {
  /** FSOrigin locating the directory (kind-tagged: git repo coords / local base). */
  origin?: (Partial<GitOrigin> & { kind?: string }) | null;
  /** Local resolved path of the directory (per-machine cache; absent on a
   *  received folder until its checkout is materialized). */
  path?: string | null;
}

// `implements IFolder` only checks the class; it contributes no members, so every
// field declared solely on IFolder read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Folder extends EntityMerge<IFolder> {}

/**
 * Folder — a first-class entity referencing a filesystem directory (project
 * context folders; git-backed ones carry a transportable GitOrigin).
 *
 * Mirrors `flow_sdk.builtin.folder.Folder`. Registered so `useEntity` /
 * `dataManager` can resolve folder typeids — e.g. the git-link chip on
 * push-notify messages, which reads `origin` for the pull wizard and
 * `displayName` for its label. Without a registered class the EntityFactory
 * drops folder rows and chips degrade to bare typeids.
 */
@registerEntity
export class Folder extends APIEntity<Folder> implements IFolder {
  origin: (Partial<GitOrigin> & { kind?: string }) | null = null;
  path: string | null = null;
  static type: string = 'folder';

  constructor(entity: Partial<IFolder> = {}) {
    super(entity);
    this.origin = (entity.origin as Folder['origin']) ?? null;
    this.path = (entity.path as string | null) ?? null;
  }
}

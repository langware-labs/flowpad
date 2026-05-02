import { EntityExpansion } from '.';
import { IResource } from './IResource';

/**
 * IEntity - Interface for database-persisted entities.
 *
 * Extends IResource with entity-specific fields like uname, schema_version, and expand.
 * Also maintains Date versions of timestamps for backwards compatibility.
 */
export interface IEntity extends Partial<IResource> {
  /** Unique name (URL-safe identifier) */
  uname?: string;
  /** Display name */
  name?: string;
  /** Entity status */
  status?: string;
  /** Schema version for migrations */
  schema_version?: string;
  /** Entity expansion configuration */
  expand?: EntityExpansion;
  /** Creation timestamp as Date (for backwards compatibility) */
  created_date?: Date;
  /** Last modified timestamp as Date (for backwards compatibility) */
  updated_date?: Date;
  /** VFS path relative to a root entity (e.g., compute node) */
  root_vfs_path?: string;
  /** VFS path to the source Record on the filesystem */
  vfs_record?: string;
  /** True when the linked Record has been deleted (Entity persists as tombstone) */
  vfs_orphan?: boolean;
  /** True when this entity belongs to an SDK-shipped system project. Hidden by default. */
  system?: boolean;
  /**
   * Generic context-entity references. The unified container for "what other
   * entities is this entity contextually related to." On the wire, each entry
   * is a TypeId-formatted string ("type-id"); in code, entities expose a typed
   * ``contextEntities`` getter that merges this list with per-entity-projected
   * direct fields. Frontend code must NOT push to this array directly — use
   * ``addContextEntity`` / ``removeContextEntity``.
   */
  context_entities?: string[];
}

export const defaultEntityType = 'entity_base';

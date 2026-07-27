import { EntityExpansion } from '.';
import { IResource } from './IResource';

/**
 * IEntity - Interface for database-persisted entities.
 *
 * Extends IResource with entity-specific fields like uname, schema_version, and expand.
 * Also maintains Date versions of timestamps for backwards compatibility.
 */
export interface IEntity extends Partial<IResource> {
  /** Hub role roster cache — one row per member with their hub-set role.
   *  Generic to any remote entity; hub-authoritative, local is a read cache.
   *  ``EntityMember``-shaped; kept as ``unknown[]`` here to avoid an import cycle. */
  members?: unknown[];
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
  /**
   * True when the FSIndexer can no longer find the on-disk Record this entity
   * was loaded from. Mirrors backend ``Entity.orphan`` (flipped on/off by the
   * FSIndexer reconcile pass). Distinct from ``vfs_orphan`` (legacy).
   */
  orphan?: boolean;
  /**
   * ISO 8601 timestamp of when ``orphan`` was last flipped to ``true``. Null
   * when the entity is not currently orphaned. Backend serializes ``datetime``
   * to string on the wire — keep it as ``string`` here.
   */
  orphan_since?: string | null;
  /** True when this entity belongs to an SDK-shipped system project. Hidden by default. */
  system?: boolean;
  /** True when this entity has a hub-side counterpart at the same id; refreshable from the hub. */
  remote?: boolean;
  /**
   * Canonical parent reference as a "<type>-<id>" TypeId string. Single source
   * of truth for parentage (supersedes the legacy per-type ``data.parent_id``).
   */
  parent_type_id?: string | null;
  /**
   * Folder-like containment (docs/entities-groups.md): id of the Group this
   * entity lives in; null = ungrouped. Mutate via ``entity.setGroup`` (the
   * generic backend action) — never write directly.
   */
  group_id?: string | null;
  /**
   * Wire-bound shared context. Each entry is a TypeId-formatted string
   * ("type-id"). Read via the typed ``sharedContextEntities`` getter.
   * Frontend code must NOT push to this array directly — call a backend
   * ``share-context`` action.
   */
  shared_context_entities?: string[];
  /**
   * Wire-bound private context. Computed server-side by
   * ``Entity.get_implicit_private_context_entities`` + the entity's
   * explicit raw bucket, deduped. Read via the typed
   * ``privateContextEntities`` getter. **The FE never combines or mutates
   * private context locally** — it just renders this array as-is.
   */
  private_context_entities?: string[];
  /**
   * Per-entry sidecar data harvested by the backend at detection time.
   * Keyed by ``str(typeid)``. For file-backed entries this is typically
   * ``{path}`` so the dock loader can self-heal a 404 via ``?hint_path=...``
   * without a reverse-id lookup. Read via ``getContextEntryData(typeid)``.
   *
   * BOTH fields are LOCAL-ONLY despite the "shared/private" prefix — the
   * prefix tracks which typeid bucket the entry indexes, not its wire
   * visibility. The stored ``path`` is an absolute filesystem path on the
   * writer's machine. The backend's ``share()`` excludes both fields from
   * the hub push so peers don't receive each other's local FS layout.
   * ``toJSON`` does still emit the shared sidecar so FE→local-BE
   * round-trips preserve the hint within the same machine.
   */
  shared_context_entity_data?: Record<string, Record<string, unknown>>;
  private_context_entity_data?: Record<string, Record<string, unknown>>;
  /**
   * Tab-strip membership (docs/tab-management.md Part 3 §4). Non-null by
   * design: removal broadcasts as ``tabbed=false`` — the wire encoder strips
   * nulled fields, so a null signal can never propagate. Mutate via the
   * compute-node ``tabs/open`` / ``tabs/close`` actions, never directly.
   */
  tabbed?: boolean;
  /** Strip ordering among member tabs (0 = unassigned). DB-only server-side. */
  tab_order?: number;
  /**
   * Epoch-ms of this tab's last activation — stamped SERVER-SIDE by the
   * generic ``activate`` action; resolver recency seed only. Legacy rows may
   * still deliver an ISO string during the transition window.
   */
  last_active_at?: number | string | null;
}

export const defaultEntityType = 'entity_base';

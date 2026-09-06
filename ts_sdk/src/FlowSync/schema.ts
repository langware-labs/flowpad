export type JSONSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

export type ActionType =
  | 'unknown'
  | 'create'
  | 'read'
  | 'update'
  | 'delete'
  | 'members'
  | 'get_related_workspace'
  | 'parents_path';

/**
 * View-mode visibility tier — mirrors the backend ``ViewMode`` StrEnum
 * (flow_sdk/schema/view_mode.py) and the UI enum in view-mode-context.tsx.
 * A type's ``browseable_by`` is the *minimum* mode at which it is browseable
 * (cumulative: standard ⊂ advanced ⊂ dev). null ⇒ never browseable.
 */
export type ViewMode = 'vibe' | 'standard' | 'advanced' | 'dev';

// Vibe is the lowest tier (simpler than Standard): a type required at 'standard'
// or above never shows in Vibe. The backend only ever emits standard/advanced/dev
// as a type's `browseable_by` (its minimum tier); 'vibe' only appears here as the
// client's *current* mode, so it just needs a well-defined rank.
const VIEW_MODE_ORDER: Record<ViewMode, number> = { vibe: 0, standard: 1, advanced: 2, dev: 3 };

/** True iff a type whose ``browseable_by`` is ``required`` shows in ``current`` (cumulative). */
export function isBrowseableIn(required: ViewMode | null | undefined, current: ViewMode): boolean {
  return required != null && VIEW_MODE_ORDER[current] >= VIEW_MODE_ORDER[required];
}

export interface JSONSchemaProperty {
  type?: JSONSchemaType;
  properties?: Record<string, JSONSchemaProperty>;
  items?: JSONSchemaProperty | JSONSchemaProperty[];
  required?: string[];
  const?: string;
  [key: string]: any;
}

/**
 * Complete reflection of the backend ``TypeInfo`` (schema_registry.py),
 * delivered one-per-type in the bootstrap ``types`` payload. ``schema`` carries
 * the JSON validation schema for entity-backed types (null otherwise); ``icon``
 * is the single source of truth for the lucide icon name (backend-owned).
 */
export interface TypeInfo {
  type_name: string;
  uid_field: string;
  index_fields: string[];
  defaults: Record<string, unknown>;
  indexed_by_default: boolean;
  browseable_by: ViewMode | null;
  creatable: boolean;
  api_visible: boolean;
  /** Storage authority for shared asset bytes. Git-backed types publish their
   *  source tree and use entity VFS refs in cloud; embedded is the legacy path. */
  cloud_file_transport?: 'embedded' | 'git';
  icon: string | null;
  /** UX-friendly label for the type (e.g. "Skills"); backend-owned, null when the
   *  type has no curated label — callers fall back to `humanizeType(type_name)`. */
  display_name: string | null;
  parent_type: string | null;
  locations: string[];
  /**
   * Placement axis — mirrors `flow_sdk/fs_store/placement.py`. The backend is the
   * ONLY authority on where an asset lands on disk; the client reads these three
   * rather than keeping its own table of subfolders (which drifts silently the
   * moment a type is reclassified).
   *
   * - `asset_class` — 'shared' | 'harness' → mounts under a harness dot-dir;
   *   'repo' → `agentic-assets/<family>` (harness-less); 'internal' → bare at the
   *   scope root (project-only). Null for types with no on-disk layout.
   * - `harness` — only meaningful for `asset_class === 'harness'`.
   * - `family` — the family segment, e.g. `skills`, `commands`, `whiteboard`.
   */
  asset_class?: 'internal' | 'harness' | 'shared' | 'none' | 'repo' | null;
  harness?: string | null;
  family?: string | null;
  /** Scope-relative subdir for the claude-default mount (e.g. `.claude/skills`,
   *  `agentic-assets/task`). Derived server-side from the three fields above. */
  main_subdir?: string | null;
  /** `'folder'` when the asset IS a directory (skill/task/mcp/agent), `'file'` when
   *  the asset IS a single file (markdown/subagent). Only a folder-layout asset can
   *  OWN nested assets under its own `agentic-assets/` — that is what the backend
   *  `repo_assets_fn` walker recurses into. */
  main_layout?: string | null;
  /** Fixed inner filename for folder-layout assets when one exists, e.g. SKILL.md. */
  main_file?: string | null;
  /** True when asset_ref is a folder (every folder-layout type): the Assets
   *  sidebar expands the row into its on-disk file tree. */
  folder_backed: boolean;
  /** THE on-disk shape declaration this type makes (the fields above are its
   *  projections): `{kind:'folder', main:'SKILL.md'}` or `{kind:'file', ext:'.md'}`. */
  shape?: { kind: 'folder'; main: string | null } | { kind: 'file'; ext: string } | null;
  /** The asset editor that opens this type (`'markdown'`, `'skill'`, …), declared
   *  once on the backend so the client never keeps a hand-maintained type→editor map. */
  editor?: string | null;
  /** The entity owns its backing file (re-rendered from the default body on every
   *  save, e.g. task/spec), so an orphaned row (file missing / no asset_ref) can
   *  self-heal with a single save. Defaults false for hand-edited files (markdown/skill). */
  owns_main_ref?: boolean;
  /** Reception seam: the verb the receive UI shows for this type — the install
   *  CTA reads ``"<reception_verb> the <typeLabel>"`` (e.g. "Set up the app"). */
  reception_verb?: string;
  /** Reception seam: the built-in skill that sets a received attachment of this
   *  type up in a Vibe session (null ⇒ it just opens). Presentational hint only —
   *  the backend owns the actual dispatch in ``Entity.setup_on_receive``. */
  setup_skill?: string | null;
  /** Reception seam: ``"auto"`` ⇒ row-only payload auto-installed at unpack
   *  (no review gate) — its chip navigates instead of opening the review modal. */
  receive_policy?: string | null;
  schema_hash: string;
  schema: JSONSchemaProperty | null;
}

export class JSONSchemaParser {
  schema: JSONSchemaProperty;

  constructor(schema: JSONSchemaProperty) {
    this.schema = schema;
  }
  get fieldNames(): string[] {
    return Object.keys(this.schema.properties || {});
  }
  get hasBlobs(): boolean {
    // check if one of the properties is a blob
    for (const key of this.fieldNames) {
      const property = this.getProperty(key);
      if (property && property.blob) {
        return true;
      }
    }
    return false;
  }
  get entity_type(): string | null {
    const typeProperty = this.getProperty('type');
    if (!typeProperty) {
      console.warn('Schema does not have a type property', this.schema);
      return null;
    }
    if (!typeProperty.const) {
      throw new Error('Schema type property is not a defined constant');
    }
    return typeProperty.const;
  }
  getProperty(propertyName: string): JSONSchemaProperty | null {
    return this.schema.properties ? this.schema.properties[propertyName] : null;
  }

  getPropertyType(propertyName: string): JSONSchemaType | null {
    const property = this.getProperty(propertyName);
    return property && property.type ? property.type : null;
  }

  isPropertyRequired(propertyName: string): boolean {
    return this.schema.required ? this.schema.required.includes(propertyName) : false;
  }

  parseAllProperties(): Record<string, JSONSchemaProperty> {
    return this.schema.properties || {};
  }
}

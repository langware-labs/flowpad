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
export type ViewMode = 'standard' | 'advanced' | 'dev';

const VIEW_MODE_ORDER: Record<ViewMode, number> = { standard: 0, advanced: 1, dev: 2 };

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
  icon: string | null;
  parent_type: string | null;
  locations: string[];
  /** True when asset_ref is a bare folder (e.g. skill): the Assets sidebar
   *  expands the row into its on-disk file tree. Derived from the folder layout. */
  folder_backed: boolean;
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

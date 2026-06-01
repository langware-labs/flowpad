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
  browseable: boolean;
  creatable: boolean;
  api_visible: boolean;
  icon: string | null;
  parent_type: string | null;
  locations: string[];
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

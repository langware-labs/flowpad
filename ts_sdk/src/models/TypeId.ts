const delimiter = '-';
/** Version-agnostic lowercase UUID source (no anchors, no flags) — the twin of the backend's
 *  `UUID_PATTERN` (`flow_sdk/api/api_types/identifier.py`). Compose it; add `i` where case-insensitive. */
export const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Entity-id UUID source: v4 or v5 only — the shape `isValidEntityId` gates on. */
export const ENTITY_UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const uuidRegex = ENTITY_UUID_SOURCE;

// Identifier patterns matching backend (hub identifier.py)
const numberLimit = 10000;
const maxDigits = numberLimit.toString().length - 2;
const namedIdPattern = /^@([a-zA-Z][a-zA-Z0-9_-]*)$/;
const keyPattern = new RegExp(`^([_a-zA-Z0-9]+)-(?:0|[1-9]\\d{0,${maxDigits}}|${numberLimit})$`);
const propIdPattern = /^([_a-zA-Z0-9]+)\.([_a-zA-Z0-9]+)$/;

/**
 * Identifier types matching backend (hub identifier.py::IdentifierType)
 */
export enum IdentifierType {
  UUID = 'uuid',
  NAMESPACE = 'namespace',
  PROP_ID = 'prop_id',
  NAMED = 'named',
  UNKNOWN = 'unknown',
}

/** An entity id: a lowercase UUID v4 or v5 — the same gate as the backend's `is_valid_entity_id`
 *  (`flow_sdk/api/api_types/identifier.py`), which rejects uppercase too. */
export function isValidEntityId(id: string): boolean {
  return new RegExp(`^${uuidRegex}$`).test(id);
}

/** Any UUID, any version or case — the backend's version-agnostic `is_valid_uuid` (a name that is
 *  only an id, say). Not an entity-id gate: that is `isValidEntityId`. */
export function isValidUuid(text: string): boolean {
  return new RegExp(`^${UUID_SOURCE}$`, 'i').test(text);
}

/** An id taken from outside (pasted, from a URL) as an entity id: trimmed and lowercased, then
 *  gated by `isValidEntityId` — null when it is not one. */
export function normalizeEntityId(raw: string | null | undefined): string | null {
  const id = (raw ?? '').trim().toLowerCase();
  return isValidEntityId(id) ? id : null;
}

/**
 * Check if identifier is a valid named ID (@name format)
 * Matches backend: hub identifier.py::is_valid_named_id
 */
export function isValidUName(id: string): boolean {
  return namedIdPattern.test(id);
}

/**
 * Check if identifier is a valid namespace key (namespace-index format)
 * Matches backend: hub identifier.py::is_valid_key
 */
export function isValidKey(id: string): boolean {
  return keyPattern.test(id);
}

/**
 * Check if identifier is a valid property ID (property.value format)
 * Matches backend: hub identifier.py::is_valid_prop_id
 */
export function isValidPropId(id: string): boolean {
  return propIdPattern.test(id);
}

/**
 * Check if identifier is valid (any of the 4 supported types)
 * Supports: UUID, namespace key, property ID, or named ID
 */
export function isValidIdentifier(id: string): boolean {
  return isValidEntityId(id) || isValidKey(id) || isValidPropId(id) || isValidUName(id);
}

/**
 * Determine the type of an identifier
 * Matches backend: hub identifier.py::get_identifier_type
 *
 * @param identifier - The identifier string to classify
 * @returns The identifier type enum value
 */
export function getIdentifierType(identifier: string): IdentifierType {
  if (!identifier) {
    return IdentifierType.UNKNOWN;
  }

  // Check in priority order matching backend
  if (isValidEntityId(identifier)) {
    return IdentifierType.UUID;
  }
  if (isValidKey(identifier)) {
    return IdentifierType.NAMESPACE;
  }
  if (isValidPropId(identifier)) {
    return IdentifierType.PROP_ID;
  }
  if (isValidUName(identifier)) {
    return IdentifierType.NAMED;
  }

  return IdentifierType.UNKNOWN;
}

export function isEntity(entity: any): boolean {
  return typeof entity === 'object' && 'typeId' in entity;
}

export function isTypeId(typeId: unknown): boolean {
  const parts = parseTypeId(typeId);
  return parts !== null;
}

/**
 * Parse a TypeId string into [type, identifier] parts
 * Matches backend: hub type_id.py::TypeId.__init__ (line 62)
 *
 * Splits on the FIRST delimiter only, allowing identifiers to contain delimiters
 * Examples:
 *   "agent-550e8400-..." -> ["agent", "550e8400-..."]
 *   "agent-@local" -> ["agent", "@local"]
 *   "workspace-WORKSPACE-123" -> ["workspace", "WORKSPACE-123"]
 *   "user-email.john_doe" -> ["user", "email.john_doe"]
 */
function parseTypeId(typeId: unknown): string[] | null {
  if (typeof typeId !== 'string') {
    return null;
  }

  // Split at the first dash only (matching backend behavior)
  const firstDashIndex = typeId.indexOf(delimiter);
  if (firstDashIndex === -1) {
    return null; // No delimiter found
  }

  const entityType = typeId.substring(0, firstDashIndex);
  const entityId = typeId.substring(firstDashIndex + 1);

  if (!entityType || !entityId) {
    return null; // Empty type or id
  }

  // Validate that the identifier part is a real entity identifier (UUID, @name, namespace key, or prop_id).
  // Without this, any string containing a dash (e.g. "my-project", "/Users/some-path")
  // would be incorrectly treated as a TypeId by deepAssign, converting string fields to TypeId objects.
  if (!isValidIdentifier(entityId)) {
    return null;
  }

  return [entityType, entityId];
}

export class TypeId {
  type: string;
  id: string;
  static readonly DELIMITER: string = delimiter;

  constructor(typeIdOrType: string | TypeId, id?: string) {
    if (id === undefined) {
      if (typeof typeIdOrType === 'string') {
        if (!isTypeId(typeIdOrType)) {
          throw new Error('Invalid typeId');
        }
        const parts = parseTypeId(typeIdOrType);
        if (!parts) {
          throw new Error('Parsing error: Invalid typeId');
        }
        this.type = parts[0];
        this.id = parts[1];
      } else if (typeIdOrType instanceof TypeId) {
        this.type = typeIdOrType.type;
        this.id = typeIdOrType.id;
      } else {
        throw new Error(`Invalid typeId input:${String(typeIdOrType)}`);
      }
    } else if (typeof typeIdOrType === 'string') {
      if (typeIdOrType.includes(delimiter) || !id) {
        throw new Error(`Invalid type-id: ${typeIdOrType}, ${id}`);
      }
      if (!isValidIdentifier(id)) {
        throw new Error(`Invalid type-id: ${typeIdOrType}, ${id}`);
      }
      this.type = typeIdOrType;
      this.id = id;
    } else {
      throw new Error(`Invalid type-id input: ${String(typeIdOrType)}, ${id}`);
    }
  }

  /**
   * Get the identifier type for this TypeId
   * Matches backend: hub type_id.py::TypeId.identifier_type (property)
   */
  get identifierType(): IdentifierType {
    return getIdentifierType(this.id);
  }

  /**
   * Alias for id field (matches backend property name)
   */
  get identifier(): string {
    return this.id;
  }

  /**
   * Extract uname from a named identifier (@uname)
   * Matches backend: hub type_id.py::TypeId.uname (property)
   */
  get uname(): string | null {
    if (this.identifier && isValidUName(this.identifier)) {
      const match = this.identifier.match(namedIdPattern);
      return match ? match[1] : null;
    }
    return null;
  }

  /**
   * Extract namespace from a namespace key (namespace-index format)
   * Matches backend: hub type_id.py::TypeId.namespace (property)
   */
  get namespace(): string | null {
    if (isValidKey(this.identifier)) {
      const match = this.identifier.match(keyPattern);
      return match ? match[1].toLowerCase() : null;
    }
    return null;
  }

  /**
   * Get the full key if this is a namespace key identifier
   * Matches backend: hub type_id.py::TypeId.key (property)
   */
  get key(): string | null {
    if (isValidKey(this.identifier)) {
      return this.identifier;
    }
    return null;
  }

  /**
   * Extract the index from a namespace key (namespace-index format)
   * Matches backend: hub type_id.py::TypeId.key_index (property)
   */
  get keyIndex(): number | null {
    if (isValidKey(this.identifier)) {
      const match = this.identifier.match(keyPattern);
      if (match) {
        // The index is everything after the namespace and dash
        const dashIndex = this.identifier.lastIndexOf('-');
        return parseInt(this.identifier.substring(dashIndex + 1), 10);
      }
    }
    return null;
  }

  /**
   * Extract property name from a property ID (property.value format)
   * Matches backend: hub type_id.py::TypeId.prop_id_name (property)
   */
  get propIdName(): string | null {
    if (isValidPropId(this.identifier)) {
      const match = this.identifier.match(propIdPattern);
      return match ? match[1] : null;
    }
    return null;
  }

  /**
   * Extract property value from a property ID (property.value format)
   * Matches backend: hub type_id.py::TypeId.prop_id_value (property)
   */
  get propIdValue(): string | null {
    if (isValidPropId(this.identifier)) {
      const match = this.identifier.match(propIdPattern);
      return match ? match[2] : null;
    }
    return null;
  }

  equals(other: TypeId | null | undefined) {
    if (!other) {
      return false;
    }
    return this.type === other.type && this.id === other.id;
  }

  toString() {
    return `${this.type}${delimiter}${this.id}`;
  }

  toUrlString() {
    return `${this.type}/${this.id}`;
  }

  toJSON() {
    return this.toString();
  }
}

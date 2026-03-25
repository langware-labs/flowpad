/**
 * IResource - Base interface for all identifiable resources in FlowPad.
 *
 * This interface provides the common fields shared between:
 * - IEntity: Database-persisted entities
 * - SystemProfileItem: Local file-based resources (hooks, MCP servers, etc.)
 *
 * All fields use standardized naming:
 * - id: Unique identifier
 * - type: Type discriminator
 * - name: Display name
 * - created_at/modified_at: ISO timestamp strings
 * - created_by/updated_by: User/agent identifiers
 */
export interface IResource {
  /** Unique identifier for the resource */
  id: string;
  /** Type discriminator (e.g., 'hook', 'mcp_server', 'project', etc.) */
  type: string;
  /** Display name */
  name: string;
  /** Creation timestamp (ISO string) */
  created_at?: string;
  /** Last modified timestamp (ISO string) */
  modified_at?: string;
  /** User/agent who created this resource */
  created_by?: string;
  /** User/agent who last modified this resource */
  updated_by?: string;
}

/**
 * Type guard to check if an object implements IResource
 */
export function isResource(obj: unknown): obj is IResource {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'id' in obj &&
    typeof (obj as IResource).id === 'string' &&
    'type' in obj &&
    typeof (obj as IResource).type === 'string' &&
    'name' in obj &&
    typeof (obj as IResource).name === 'string'
  );
}

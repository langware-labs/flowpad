import { TypeId, isTypeId } from '../models/TypeId';

/**
 * VFS Protocol constant
 */
export const VFS_PROTOCOL = 'vfs';

/** Matches a Windows drive-letter prefix: `C:\`, `C:/`, `D:\`, etc. */
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:[/\\]/;

/**
 * True when ``path`` is an absolute machine path on either POSIX or Windows.
 *
 * - POSIX:   starts with ``/`` (e.g. ``/Users/Gadi/.flow/…``)
 * - Windows: starts with a drive letter + ``:`` + ``\`` or ``/`` (e.g.
 *            ``C:\Users\…\Temp\…`` or ``C:/Users/…``)
 *
 * Use this anywhere you need to decide whether a string is a real filesystem
 * path versus an id / VFS slug / session-uuid. Both shapes are first-class:
 * the backend that produced the path reads it back with its native OS path
 * semantics (Python ``pathlib.Path`` handles either), so detection should
 * accept both.
 */
export function isAbsoluteMachinePath(path: string): boolean {
  if (!path) return false;
  return path.startsWith('/') || WINDOWS_DRIVE_PATTERN.test(path);
}

/**
 * VFSPath - Virtual File System path parser and normalizer
 *
 * Mirrors the backend VFSPath class (flowpad/hub/api/fs_api.py)
 *
 * Supported formats:
 * - Full URI: "vfs://compute_node-xxx/path/to/file"
 * - Absolute path: "compute_node-xxx/path/to/file"
 * - TypeId with path: "agent-@local/some/path"
 *
 * @example
 * ```ts
 * const vpath = VFSPath.parse('vfs://compute_node-xxx/Users/path/file.md');
 * console.log(vpath.absVfsPath);  // "compute_node-xxx/Users/path/file.md"
 * console.log(vpath.uri);         // "vfs://compute_node-xxx/Users/path/file.md"
 * console.log(vpath.typeId);      // TypeId { type: 'compute_node', id: 'xxx' }
 * console.log(vpath.entitySubPath); // "Users/path/file.md"
 * ```
 */
export class VFSPath {
  /** The VFS protocol identifier */
  static readonly PROTOCOL = VFS_PROTOCOL;

  /** Protocol prefix for VFS URIs */
  static readonly PROTOCOL_PREFIX = `${VFS_PROTOCOL}://`;

  /** The entity type (e.g., "compute_node", "agent", "project") */
  readonly type: string | null;

  /** The entity identifier (e.g., UUID, "@local", "WORKSPACE-123") */
  readonly id: string | null;

  /** The path within the entity (e.g., "Users/path/file.md") */
  readonly entitySubPath: string;

  /** The original raw path passed to the constructor */
  readonly rawPath: string;

  /**
   * Private constructor - use VFSPath.parse() instead
   */
  private constructor(rawPath: string, type: string | null, id: string | null, entitySubPath: string) {
    this.rawPath = rawPath;
    this.type = type;
    this.id = id;
    this.entitySubPath = entitySubPath;
  }

  /**
   * Parse a VFS path string into a VFSPath object
   *
   * @param vfsPath - The path to parse (with or without vfs:// protocol)
   * @returns A VFSPath object
   *
   * @example
   * ```ts
   * // All these formats are supported:
   * VFSPath.parse('vfs://compute_node-xxx/path/file.md');
   * VFSPath.parse('compute_node-xxx/path/file.md');
   * VFSPath.parse('agent-@local/some/path');
   * VFSPath.parse('/relative/path'); // No TypeId, just path
   * ```
   */
  static parse(vfsPath: string | null | undefined): VFSPath {
    if (!vfsPath) {
      return new VFSPath('', null, null, '');
    }

    let path = vfsPath;

    // Strip vfs:// protocol prefix if present
    if (path.startsWith(VFSPath.PROTOCOL_PREFIX)) {
      path = path.substring(VFSPath.PROTOCOL_PREFIX.length);
    }

    // Try to extract TypeId from the beginning of the path
    // Format: {type}-{id}/{subpath}
    const firstSlash = path.indexOf('/');

    if (firstSlash === -1) {
      // No slash - could be just a TypeId or just a filename
      if (isTypeId(path)) {
        const typeId = new TypeId(path);
        return new VFSPath(vfsPath, typeId.type, typeId.id, '');
      }
      // Just a filename or invalid path
      return new VFSPath(vfsPath, null, null, path);
    }

    const potentialTypeId = path.substring(0, firstSlash);
    const subPath = path.substring(firstSlash + 1);

    if (isTypeId(potentialTypeId)) {
      const typeId = new TypeId(potentialTypeId);
      return new VFSPath(vfsPath, typeId.type, typeId.id, subPath);
    }

    // No valid TypeId at the start - treat entire path as subpath
    return new VFSPath(vfsPath, null, null, path);
  }

  /**
   * Create a VFSPath from a TypeId and entity path
   *
   * @param typeId - The TypeId for the entity
   * @param entityPath - The path within the entity (default: "/")
   * @returns A new VFSPath object
   */
  static fromTypeId(typeId: TypeId, entityPath: string = '/'): VFSPath {
    const normalizedPath = entityPath.startsWith('/') ? entityPath.substring(1) : entityPath;
    const rawPath = `${typeId.toString()}/${normalizedPath}`;
    return new VFSPath(rawPath, typeId.type, typeId.id, normalizedPath);
  }

  /**
   * Create a VFSPath from a machine absolute path and TypeId
   *
   * @param machineAbsPath - Absolute path on the machine
   * @param typeId - TypeId for the entity (uses typeId.toString() which includes @uname format)
   * @returns A new VFSPath object
   * @throws Error if path is not absolute
   *
   * Path normalization:
   * - Windows: Remove drive prefix (C:\), convert backslashes to forward slashes
   * - Mac/Linux: Remove leading root slash
   * - Error if not an absolute path
   */
  static fromMachinePath(machineAbsPath: string, typeId: TypeId): VFSPath {
    if (!machineAbsPath) {
      throw new Error('Machine path is required');
    }

    if (!isAbsoluteMachinePath(machineAbsPath)) {
      throw new Error(`Path must be absolute. Got: ${machineAbsPath}`);
    }
    let normalizedPath: string;
    if (WINDOWS_DRIVE_PATTERN.test(machineAbsPath)) {
      // Windows: drop drive prefix (``C:\``), convert backslashes to forward slashes
      normalizedPath = machineAbsPath.substring(3).replace(/\\/g, '/');
    } else {
      // POSIX: drop leading root slash
      normalizedPath = machineAbsPath.substring(1);
    }

    // Use typeId.toString() which produces "type-@uname" if id is @uname format
    const rawPath = `${typeId.toString()}/${normalizedPath}`;
    return new VFSPath(rawPath, typeId.type, typeId.id, normalizedPath);
  }

  /**
   * Get the TypeId for this path, if available
   *
   * @returns TypeId or null if no valid TypeId is present
   */
  get typeId(): TypeId | null {
    if (!this.type || !this.id) {
      return null;
    }
    return new TypeId(this.type, this.id);
  }

  /**
   * Check if this path has a valid TypeId prefix
   */
  get isAbsolute(): boolean {
    return this.typeId !== null;
  }

  /**
   * Get the absolute VFS path WITHOUT the vfs:// protocol
   *
   * Format: "{type}-{id}/{entitySubPath}"
   *
   * @returns The normalized absolute path or empty string if no TypeId
   */
  get absVfsPath(): string {
    if (!this.type || !this.id) {
      return this.entitySubPath;
    }
    if (!this.entitySubPath) {
      return `${this.type}-${this.id}/`;
    }
    return `${this.type}-${this.id}/${this.entitySubPath}`;
  }

  /**
   * Get the full VFS URI WITH the vfs:// protocol
   *
   * Format: "vfs://{type}-{id}/{entitySubPath}"
   *
   * @returns The full URI with protocol
   */
  get uri(): string {
    return `${VFSPath.PROTOCOL_PREFIX}${this.absVfsPath}`;
  }

  /**
   * Get just the filename from the path
   *
   * @returns The filename or empty string if path ends with /
   */
  get filename(): string {
    if (!this.entitySubPath) {
      return '';
    }
    const parts = this.entitySubPath.split('/');
    return parts[parts.length - 1] || '';
  }

  /**
   * Get the parent directory path
   *
   * @returns A new VFSPath for the parent directory
   */
  get parent(): VFSPath {
    if (!this.entitySubPath || this.entitySubPath === '/') {
      return this;
    }
    const lastSlash = this.entitySubPath.lastIndexOf('/');
    if (lastSlash <= 0) {
      // At root or no slashes
      return new VFSPath(this.typeId ? `${this.typeId.toString()}/` : '', this.type, this.id, '');
    }
    const parentSubPath = this.entitySubPath.substring(0, lastSlash);
    return new VFSPath(
      this.typeId ? `${this.typeId.toString()}/${parentSubPath}` : parentSubPath,
      this.type,
      this.id,
      parentSubPath,
    );
  }

  /**
   * Check if this path starts with another path
   *
   * @param other - The path to check against (string or VFSPath)
   * @returns true if this path starts with the other path
   */
  startsWith(other: string | VFSPath): boolean {
    const otherPath = typeof other === 'string' ? VFSPath.parse(other) : other;
    return this.absVfsPath.startsWith(otherPath.absVfsPath);
  }

  /** Check if another path is a descendant of this path */
  isChild(other: VFSPath): boolean {
    return other.absVfsPath.startsWith(this.absVfsPath);
  }

  /**
   * Check if two VFSPaths are equal (same absVfsPath)
   */
  equals(other: VFSPath | null | undefined): boolean {
    if (!other) {
      return false;
    }
    return this.absVfsPath === other.absVfsPath;
  }

  /**
   * Convert to string (returns absVfsPath)
   */
  toString(): string {
    return this.absVfsPath;
  }

  /**
   * Convert to JSON (returns absVfsPath)
   */
  toJSON(): string {
    return this.absVfsPath;
  }
}

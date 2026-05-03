import { APIEntity, registerEntity } from '../../APIEntity';
import { ArtifactTypeInfo, ArtifactTypeMetadata } from './artifact-type-info';
import { ArtifactReferenceType, ArtifactRelationType, ArtifactType, CodebaseReferenceType } from './artifact-types';

// Re-export for backward compatibility
export { ArtifactReferenceType, ArtifactRelationType, ArtifactType, CodebaseReferenceType };

export interface ICodeRef {
  id?: string;
  name: string;
  ref_type: CodebaseReferenceType;
  path: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Reference to a piece of code - can be file, folder, glob pattern, or external reference.
 */
@registerEntity
export class CodeRef extends APIEntity<CodeRef> implements ICodeRef {
  static type: string = 'code_ref';
  name: string;
  ref_type: CodebaseReferenceType;
  path: string;
  description?: string;
  metadata?: Record<string, unknown>;

  constructor(entity: Partial<ICodeRef> = {}) {
    super(entity);
    this.name = entity.name || '';
    this.ref_type = entity.ref_type || CodebaseReferenceType.FILE;
    this.path = entity.path || '';
    this.description = entity.description;
    this.metadata = entity.metadata;
  }

  protected validateStructure(): void {
    const errors: string[] = [];

    if (!this.name || this.name.trim() === '') {
      errors.push('name is required');
    }

    if (errors.length > 0) {
      throw new Error(`Invalid CodeRef structure: ${errors.join(', ')}`);
    }
  }

  get fileType(): string | null {
    if (this.ref_type !== CodebaseReferenceType.FILE) {
      return null;
    }

    const lastDot = this.path.lastIndexOf('.');
    if (lastDot === -1) return null;

    return this.path.slice(lastDot + 1);
  }
}

export interface IArtifact extends ICodeRef {
  artifact_type?: ArtifactType;
  project_id?: string;
  generating_flow_id?: string;
  metadata?: Record<string, unknown>;
  // Service control fields (for WEBAPP and APP_SERVICE types)
  /** Port number for services */
  port?: string;
  /** Command to start/restart the service */
  start_cmd?: string;
  /** Health check endpoint path */
  health?: string;
}

/**
 * Artifact - extends CodeRef with artifact-specific metadata.
 * Represents a filesystem entity or reference created during execution.
 */
@registerEntity
export class Artifact extends CodeRef implements IArtifact {
  static type: string = 'artifact';
  artifact_type?: ArtifactType;
  project_id?: string;
  generating_flow_id?: string;
  metadata?: Record<string, unknown>;
  // Service control fields
  port?: string;
  start_cmd?: string;
  health?: string;

  constructor(entity: Partial<IArtifact> = {}) {
    super(entity);
    this.artifact_type = entity.artifact_type;
    this.project_id = entity.project_id;
    this.generating_flow_id = entity.generating_flow_id;
    this.metadata = entity.metadata;
    // Extract service fields from entity or metadata (check both underscore and hyphen keys)
    this.port = entity.port ?? (entity.metadata?.port as string | undefined);
    this.start_cmd =
      entity.start_cmd ??
      (entity.metadata?.start_cmd as string | undefined) ??
      (entity.metadata?.['start-cmd'] as string | undefined);
    this.health = entity.health ?? (entity.metadata?.health as string | undefined);

    // Validate required fields
    this.validateStructure();
  }

  /**
   * Service-style artifacts often have no ``name`` but DO have a ``port`` —
   * showing ``Port 3000`` is more useful to the user than the default
   * ``artifact-04…2b`` id-tail. Defers to the chain when ``name`` is set.
   */
  override getDisplayName(): string | null {
    if (this.name && this.name.trim()) return null;
    if (this.port) return `Port ${this.port}`;
    return null;
  }

  get typeInfo(): ArtifactTypeInfo {
    const artifactType = this.artifact_type || ArtifactType.FILE;
    return ArtifactTypeMetadata.fromArtifactType(artifactType);
  }
}

export interface IArtifactRelation {
  id?: string;
  source_artifact_id: string;
  target_artifact_id: string;
  relation_type: ArtifactRelationType;
  metadata?: Record<string, unknown>;
}

@registerEntity
export class ArtifactRelation extends APIEntity<ArtifactRelation> implements IArtifactRelation {
  static type: string = 'artifact_relation';
  source_artifact_id: string;
  target_artifact_id: string;
  relation_type: ArtifactRelationType;
  metadata: Record<string, unknown>;

  constructor(entity: Partial<IArtifactRelation> = {}) {
    super(entity);
    this.source_artifact_id = entity.source_artifact_id || '';
    this.target_artifact_id = entity.target_artifact_id || '';
    this.relation_type = entity.relation_type || ArtifactRelationType.REFERENCES;
    this.metadata = entity.metadata || {};
  }
}

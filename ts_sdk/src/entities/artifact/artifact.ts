import { APIEntity, isNonEmptyString, registerEntity } from '../../APIEntity';
import type { IEntity } from '../../IEntity';
import { DockPointerData } from '../../models/DockPointer';
import type { FSOriginField, FSOriginInput } from '../../models/FSOrigin';
import { normalizeFSOrigin } from '../../models/FSOrigin';
import { ARTIFACT_KINDS, normalizeKind } from '../../models/Kind';
import { ViewType } from '../../utils/ui/view-types';
import { WorldViewProjection } from '../../worldview/projection';

/** The clean logical/source-plane Artifact contract. Kinds remain open strings. */
export interface IArtifact extends IEntity {
  name: string;
  kind: string;
  description?: string;
  origin?: FSOriginField | null;
  project_id?: string | null;
  /** Path of the asset this artifact REFERENCES. It never owns the path. */
  asset_ref?: string;
  /**
   * TypeId of the entity this artifact references, e.g. `source_item-<uuid>`.
   * `asset_ref` addresses a deliverable that is a file; this addresses one that
   * is a row — a sent message, a created record — which has no path at all.
   */
  target_type_id?: string | null;
  /** TypeId of the run that produced it, e.g. `agentic_process-<uuid>`. */
  generated_by?: string | null;
}

/** Private compatibility input for rows received before the Artifact migration. */
interface LegacyArtifactInput {
  artifact_type?: string | null;
  ref_type?: string | null;
  path?: string | null;
  metadata?: Record<string, unknown> | null;
  generating_flow_id?: string | null;
  git_origin?: FSOriginInput | null;
  port?: string | number | null;
  start_cmd?: string | null;
  health?: string | null;
}

const LEGACY_KIND_MAP: Readonly<Record<string, string>> = {
  WEBAPP: ARTIFACT_KINDS.APPLICATION_WEB,
  WEBPAGE: 'content.web.page',
  APP_SERVICE: 'workload.service',
  CLOUD_SERVICE: 'resource.infrastructure',
  FUNCTION: 'workload.function',
  FILE: ARTIFACT_KINDS.CONTENT_FILE,
  TEXT_FILE: 'content.file.text',
  DATA: ARTIFACT_KINDS.CONTENT_DATA,
};

const RETIRED_ARTIFACT_KEYS = [
  'artifact_type',
  'ref_type',
  'path',
  'metadata',
  'generating_flow_id',
  'git_origin',
  'port',
  'start_cmd',
  'health',
] as const;

function kindFromLegacy(type: string | null | undefined): string {
  return LEGACY_KIND_MAP[String(type || 'FILE').toUpperCase()] ?? ARTIFACT_KINDS.CONTENT_FILE;
}

/**
 * Artifact describes what something is, how it composes through canonical
 * parentage, and where its source lives. Runtime/provider state belongs only
 * to Deployment.
 */
@registerEntity
export class Artifact extends APIEntity<Artifact> implements IArtifact {
  static type: string = 'artifact';

  name: string;
  kind: string;
  description?: string;
  origin: FSOriginField | null;
  project_id: string | null;
  asset_ref: string;
  target_type_id: string | null;
  /**
   * Provenance. Deliberately NOT a revival of the retired `generating_flow_id`
   * (which stays in RETIRED_ARTIFACT_KEYS and is deleted, never aliased):
   * dropped provenance stays dropped rather than reappearing with new meaning.
   */
  generated_by: string | null;

  constructor(entity: Partial<IArtifact> | (Partial<IArtifact> & LegacyArtifactInput) = {}) {
    super(entity);
    const legacy = entity as Partial<IArtifact> & LegacyArtifactInput;
    const metadataOrigin = legacy.metadata?.git_origin as FSOriginInput | undefined;

    this.name = entity.name ?? '';
    this.kind = normalizeKind(entity.kind ?? kindFromLegacy(legacy.artifact_type));
    this.description = entity.description;
    this.origin = normalizeFSOrigin((entity.origin ?? legacy.git_origin ?? metadataOrigin) as FSOriginInput | null);
    this.project_id = entity.project_id ?? null;
    this.asset_ref = entity.asset_ref ?? '';
    this.target_type_id = entity.target_type_id ?? null;
    this.generated_by = entity.generated_by ?? null;

    // APIEntity.deepAssign intentionally accepts open wire payloads. Remove
    // legacy keys it copied before they can become a public runtime/write
    // surface; the canonical values above are the only retained projection.
    for (const key of RETIRED_ARTIFACT_KEYS) {
      delete (this as unknown as Record<string, unknown>)[key];
    }

    this.validateStructure();
  }

  override get dockPointer(): DockPointerData {
    return new DockPointerData(ViewType.WORLDVIEW, WorldViewProjection.DEPLOYMENT, {
      focus: `${Artifact.type}-${this.id}`,
      selected: `${Artifact.type}-${this.id}`,
    });
  }

  override toJSON(): Record<string, unknown> {
    const json = super.toJSON() as Record<string, unknown>;
    for (const key of RETIRED_ARTIFACT_KEYS) delete json[key];
    json.kind = this.kind;
    json.origin = this.origin;
    json.asset_ref = this.asset_ref;
    json.target_type_id = this.target_type_id;
    json.generated_by = this.generated_by;
    return json;
  }

  protected validateStructure(): void {
    if (!isNonEmptyString(this.name)) {
      throw new Error('Invalid Artifact structure: name is required');
    }
  }
}

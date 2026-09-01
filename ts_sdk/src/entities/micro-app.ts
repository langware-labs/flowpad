import { ActionInfo } from '../models/ActionInfo';
import { APIEntity, registerEntity } from '../APIEntity';
import type { IEntity, EntityMerge } from '../IEntity';

export type AppLocationType = 'Folder' | 'Builtin' | 'GCPBucket' | 'Artifact';

export interface IMicroApp extends IEntity {
  name: string;
  location_type: AppLocationType;
  location_root?: string | null;
  domains?: string[] | null;
  /** The Artifact this delivers. Null for standalone folder/builtin apps. */
  artifact_id?: string | null;
  project_id?: string | null;
  /** Dot-path ontology kind (backend default `application.web`); an index field
   *  on the type — see `flow_sdk/builtin/faas/micro_app.py`. */
  kind?: string | null;
}

// `implements IMicroApp` only checks the class; it contributes no members, so every
// field declared solely on IMicroApp read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MicroApp extends EntityMerge<IMicroApp> {}

/**
 * MicroApp is the *delivery* plane of an app: its built output, served by the
 * backend at the backend's own origin.
 *
 * An app is one Artifact (source) with up to two companions — a Deployment
 * (a dev server on a port) and a MicroApp (built output we serve). Which one is
 * live changes without the app changing, which is why neither is the app's
 * identity.
 */
@registerEntity
export class MicroApp extends APIEntity<MicroApp> implements IMicroApp {
  static type: string = 'micro_app';

  name: string;
  location_type: AppLocationType;
  location_root: string | null;
  domains: string[] | null;
  artifact_id: string | null;
  project_id: string | null;
  kind: string | null;

  constructor(entity: Partial<IMicroApp> | IEntity = {}) {
    super(entity);
    const app = entity as Partial<IMicroApp>;
    this.name = app.name ?? '';
    this.location_type = app.location_type ?? 'Artifact';
    this.location_root = app.location_root ?? null;
    this.domains = app.domains ?? null;
    this.artifact_id = app.artifact_id ?? null;
    this.project_id = app.project_id ?? null;
    this.kind = app.kind ?? null;
  }

  /**
   * URL serving this app's `index.html`, on the backend's own origin.
   *
   * Same origin as the API is the whole point: cookies ride along, there is no
   * CORS to configure, and the injected `__FLOWPAD_API_URL__` makes the page's
   * SDK target the backend that served it — locally and in cloud alike. Built
   * through `ActionInfo` so the base URL stays owned by the SDK config, exactly
   * like `AgenticProcess.getWebAppHostUrl`.
   */
  get viewUrl(): string {
    return new ActionInfo('view', MicroApp.type, this.id).fullActionUrl;
  }
}

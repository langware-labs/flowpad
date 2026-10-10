import { APIEntity, registerEntity } from '../APIEntity';
import type { IEntity, EntityMerge } from '../IEntity';

export interface IWebApp extends IEntity {
  name: string;
  description?: string | null;
  project_id?: string | null;
  /** Dot-path ontology kind (backend default `application.web`); an index field
   *  on the type — see `flow_sdk/builtin/faas/micro_app.py`. */
  kind?: string | null;
  /** Served subdir inside the app folder. */
  build?: string | null;
}

// `implements IWebApp` only checks the class; it contributes no members, so every
// field declared solely on IWebApp read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WebApp extends EntityMerge<IWebApp> {}

/**
 * WebApp is the DEFINITION of a web app — a `webapp.json` folder asset.
 *
 * It says what the app is; it serves nothing. Where it runs is a Deployment and
 * what that answers on is a `ServiceEndpoint` whose `webapp_id` names this row —
 * that endpoint is what a display loads.
 */
@registerEntity
export class WebApp extends APIEntity<WebApp> implements IWebApp {
  static type: string = 'micro_app';

  name: string;
  description: string | null;
  project_id: string | null;
  kind: string | null;
  build: string | null;

  constructor(entity: Partial<IWebApp> | IEntity = {}) {
    super(entity);
    const app = entity as Partial<IWebApp>;
    this.name = app.name ?? '';
    this.description = app.description ?? null;
    this.project_id = app.project_id ?? null;
    this.kind = app.kind ?? null;
    this.build = app.build ?? null;
  }
}

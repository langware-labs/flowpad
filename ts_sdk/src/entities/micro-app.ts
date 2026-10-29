import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';
import type { IEntity, EntityMerge } from '../IEntity';
import type { WebAudience } from './service-endpoint';

/** One way the app is served when placed. Twin of `WebappMountSpec`, the fields the UI reads. */
export interface WebAppMount {
  audience?: WebAudience | null;
  /** Where under the audience proxy; `''` is that audience's root app. */
  path?: string | null;
}

/** One rule of the app's `setup/webapp_errors.json`. */
export interface WebAppErrorRule {
  id: string;
  type: string;
  source: string;
  pattern: string;
  action: 'ignore' | 'recover';
  fix: string;
  learned_at: string;
  seen: number;
}

/** One entry of the app's error log (`setup/logs/errors.jsonl`). */
export interface WebAppErrorLogEntry {
  at: string;
  source: string;
  text: string;
  rule: string | null;
  action: 'ignore' | 'recover';
  outcome: string;
}

/** The app's `setup/` folder, as the editor's Setup tab shows it (`GET micro_app/<id>/setup-state`). */
export interface WebAppSetupState {
  setup_dir: string;
  rules: WebAppErrorRule[];
  recovery_md: string;
  errors: WebAppErrorLogEntry[];
  has_start_app: boolean;
  /** The last time the page was checked: usable or not. */
  last_check: { at: string; usable: boolean; outcome: string; errors: number } | null;
}

export interface IWebApp extends IEntity {
  name: string;
  description?: string | null;
  project_id?: string | null;
  /** Dot-path ontology kind (backend default `application.web`); an index field
   *  on the type — see `flow_sdk/builtin/faas/micro_app.py`. */
  kind?: string | null;
  /** Served subdir inside the app folder. */
  build?: string | null;
  /** How the app is served when placed; empty means the `app` audience. */
  mounts?: WebAppMount[] | null;
  /** Report the page's JS errors to Flowpad while it loads (backend default true). */
  report_errors?: boolean | null;
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
  mounts: WebAppMount[];
  report_errors: boolean;

  constructor(entity: Partial<IWebApp> | IEntity = {}) {
    super(entity);
    const app = entity as Partial<IWebApp>;
    this.name = app.name ?? '';
    this.description = app.description ?? null;
    this.project_id = app.project_id ?? null;
    this.kind = app.kind ?? null;
    this.build = app.build ?? null;
    this.mounts = app.mounts ?? [];
    this.report_errors = app.report_errors ?? true;
  }

  /** An app is labelled by its title ("Sales Desk"); `name` is the folder slug. */
  override getDisplayName(): string | null {
    return this.title?.trim() || null;
  }

  /** The app's setup folder: error rules, recovery.md and the error log. */
  async setupState(): Promise<WebAppSetupState | null> {
    const info = new ActionInfo('setup-state', WebApp.type, this.typeId.id, 'GET');
    return (await dataManager.callAction<void, WebAppSetupState>(info)) ?? null;
  }

  /** Set one error rule to ignore or recover; answers the updated setup state. */
  async setRuleAction(rule: string, action: 'ignore' | 'recover'): Promise<WebAppSetupState | null> {
    const info = new ActionInfo('setup-rule', WebApp.type, this.typeId.id, 'POST');
    info.bodyParameters = { rule, rule_action: action };
    return (await dataManager.callAction<unknown, WebAppSetupState>(info)) ?? null;
  }

  /** Who the app is for. Known from the definition alone, so it holds before the app ever ran. */
  get audience(): WebAudience {
    return this.mounts[0]?.audience ?? 'app';
  }

  /** Whether the app is its audience's root app. */
  get isRoot(): boolean {
    return this.mounts.some((mount) => mount.path === '');
  }
}

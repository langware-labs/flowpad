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

/** Where a web app is on this machine — `webapp.lifecycle` (`flow_sdk/schema/data_spec/webapp_lifecycle_spec.py`). */
export type WebAppLifecycleState =
  | 'down'
  | 'installing'
  | 'building'
  | 'starting'
  | 'up'
  | 'degraded'
  | 'recovering'
  | 'failed'
  | 'needs_person';

/** States whose page is on screen: the frame is shown iff the record is in one. */
export const SHOWABLE_STATES: readonly WebAppLifecycleState[] = ['up', 'degraded'];
/** States in which the backend is working on the app: never ask it to come up again. */
export const BUSY_STATES: readonly WebAppLifecycleState[] = ['installing', 'building', 'starting', 'recovering'];

/** One typed failure (`webapp.failure`). */
export interface WebAppFailure {
  phase: string;
  code: string;
  source: string;
  text: string;
  fingerprint: string;
  raw?: string;
  process?: string;
  at?: string | null;
}

/** What recovery already tried for one fingerprint (`webapp.attempts`). */
export interface WebAppAttempt {
  fingerprint: string;
  handled: number;
  deterministic: number;
  agent: number;
  last_agent_at?: string | null;
  last_outcome: 'fixed' | 'not_fixed' | '';
}

/** THE record of a web app on this machine (`webapp.lifecycle`), carried on every `WebApp` GET and push. */
export interface WebAppLifecycle {
  webapp_id: string;
  project_id?: string;
  state: WebAppLifecycleState;
  detail: string;
  recovery: string;
  since?: string | null;
  checked_at?: string | null;
  ports: Record<string, number>;
  pids: Record<string, number>;
  /** The page reports itself (the relay's reporter is in front of it). */
  reporter: boolean;
  /** The served document the record is about; a page report for any other one is ignored. */
  load_id: string;
  install_stamp?: string;
  build_stamp?: string;
  failure: WebAppFailure | null;
  attempts: WebAppAttempt[];
  /** The fixer run going: `<compute_op typeid>/<call id>`; '' when none. */
  agent_call: string;
  setup_owed: string;
}

export const isAppShowable = (record: WebAppLifecycle | null | undefined): boolean =>
  !!record && SHOWABLE_STATES.includes(record.state);
export const isAppBusy = (record: WebAppLifecycle | null | undefined): boolean =>
  !!record && BUSY_STATES.includes(record.state);

/** What a learned handling does (`webapp.handling.action`). */
export type WebAppHandlingAction =
  | 'ignore'
  | 'restart'
  | 'setup'
  | 'free_ports'
  | 'reinstall'
  | 'rebuild'
  | 'run'
  | 'escalate'
  | 'needs_person';

export const HANDLING_ACTIONS: readonly WebAppHandlingAction[] = [
  'ignore',
  'restart',
  'setup',
  'free_ports',
  'reinstall',
  'rebuild',
  'run',
  'escalate',
  'needs_person',
];

/** One learned handling of the app's `setup/webapp_handlings.json` (`webapp.handling`). */
export interface WebAppHandling {
  id: string;
  fingerprint: string;
  pattern: string;
  phase?: string | null;
  code?: string | null;
  source: string;
  action: WebAppHandlingAction;
  arg: string;
  learned_at: string;
  fixed: number;
  not_fixed: number;
  note: string;
}

/** One row of the app's failure log. */
export interface WebAppErrorLogEntry {
  at: string;
  phase?: string;
  code?: string;
  source: string;
  text: string;
  fingerprint?: string;
  handling: string | null;
  action: string;
  outcome: string;
}

/** The app's `setup/` folder, as the editor's Setup tab shows it (`GET micro_app/<id>/setup-state`). */
export interface WebAppSetupState {
  setup_dir: string;
  /** The app's own learned handlings (editable). */
  handlings: WebAppHandling[];
  /** Handlings Flowpad ships for every app (read-only). */
  shipped: WebAppHandling[];
  /** The handlings file could not be read: why ('' when it could). */
  handlings_problem: string;
  recovery_md: string;
  errors: WebAppErrorLogEntry[];
  has_start_app: boolean;
  lifecycle: WebAppLifecycle | null;
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
  /** The app's record on this machine — computed by the backend on every GET and push; never written. */
  lifecycle?: WebAppLifecycle | null;
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
  lifecycle: WebAppLifecycle | null;

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
    this.lifecycle = app.lifecycle ?? null;
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

  /** Turn one learned handling to another action; answers the updated setup state. */
  async setRuleAction(rule: string, action: WebAppHandlingAction): Promise<WebAppSetupState | null> {
    const info = new ActionInfo('setup-rule', WebApp.type, this.typeId.id, 'POST');
    info.bodyParameters = { rule, rule_action: action };
    return (await dataManager.callAction<unknown, WebAppSetupState>(info)) ?? null;
  }

  /** The app's record, read now (`GET micro_app/<id>/lifecycle`). */
  async readLifecycle(): Promise<WebAppLifecycle | null> {
    const info = new ActionInfo('lifecycle', WebApp.type, this.typeId.id, 'GET');
    return (await dataManager.callAction<void, WebAppLifecycle>(info)) ?? null;
  }

  /** Bring the app up (opening it means: make it work); answers its record. Idempotent on the backend. */
  async up(display = '', wait = false): Promise<WebAppLifecycle | null> {
    const info = new ActionInfo('up', WebApp.type, this.typeId.id, 'POST');
    info.bodyParameters = { display, wait };
    return (await dataManager.callAction<unknown, WebAppLifecycle>(info)) ?? null;
  }

  /** A person's Fix it: bring the app up again, the fixer allowed to run again; answers its record. */
  async fix(display = ''): Promise<WebAppLifecycle | null> {
    const info = new ActionInfo('fix', WebApp.type, this.typeId.id, 'POST');
    info.bodyParameters = { display };
    return (await dataManager.callAction<unknown, WebAppLifecycle>(info)) ?? null;
  }

  /** Stop the app's run and processes on this machine; answers its record. */
  async stop(): Promise<WebAppLifecycle | null> {
    const info = new ActionInfo('stop', WebApp.type, this.typeId.id, 'POST');
    return (await dataManager.callAction<void, WebAppLifecycle>(info)) ?? null;
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

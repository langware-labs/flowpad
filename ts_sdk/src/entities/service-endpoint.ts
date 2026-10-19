import { APIEntity, dataManager, isNonEmptyString, registerEntity } from '../APIEntity';
import type { IEntity, EntityMerge } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import type { HttpMethod } from '../models/ApiUrl';
import { normalizeKind } from '../models/Kind';
import type { DeploymentStatus } from './deployment';

/** The shipped protocol vocabulary. An external one lives under its own `--ns--` first segment. */
export const PROTOCOL_WEB_APP = 'web.app';
export const PROTOCOL_API_REST = 'api.rest';
export const PROTOCOL_API_CHAT_OPENAI = 'api.chat.openai';
export const PROTOCOL_API_MCP = 'api.mcp';
export const PROTOCOL_WORKSPACE = 'flowpad.workspace';

const NAMESPACE_SEGMENT = /^--([a-z0-9_]+)--$/;

/**
 * `web` for a browser-facing protocol, else `api`. Twin of `surface_of` in
 * `flow_sdk/schema/data_spec/service_endpoint_spec.py` — the first segment after an
 * optional namespace marker decides, and an unknown family is `api` (only `web` is
 * ever given an origin of its own).
 */
export function surfaceOf(kind: string): 'web' | 'api' {
  const normalized = normalizeKind(kind);
  if (normalized === PROTOCOL_WORKSPACE) return 'web';
  const segments = normalized.split('.');
  const family = NAMESPACE_SEGMENT.test(segments[0]) ? segments[1] : segments[0];
  return family === 'web' ? 'web' : 'api';
}

/** What the service speaks — the `Tagged` wire form: the kind beside the protocol's own fields. */
export interface ServiceProtocol {
  spec_kind: string;
  [field: string]: unknown;
}

export interface StaticBackend {
  type: 'static';
  root: string;
}

export interface ProxyBackend {
  type: 'proxy';
  port: number;
  start_cmd?: string | null;
  health?: string;
}

/** A message channel: each request is a message on `data_source_id`, its recorded reply the answer — a deployed agent's `chat` endpoint. */
export interface ChannelBackend {
  type: 'channel';
  data_source_id: string;
}

/** One app behind an audience proxy: how its bytes are produced, and which app it is. Twin of `RouteSpec`. */
export interface RouteSpec {
  backend: StaticBackend | ProxyBackend;
  /** The webapp definition (`micro_app`) this route serves, when it serves one. */
  webapp_id?: string | null;
  /** The Artifact this route serves, when it serves one. */
  artifact_id?: string | null;
}

/**
 * One proxy, many apps — the backend of a placement's `admin` and `app` endpoints. The first path
 * segment picks the app (a key of `routes`, its MOUNT); `''` is the audience's root app.
 */
export interface RoutedBackend {
  type: 'routed';
  routes: Record<string, RouteSpec>;
}

export type ServiceBackend = StaticBackend | ProxyBackend | ChannelBackend | RoutedBackend;

/**
 * What an endpoint is FOR (its kind, `service_endpoint.<subkind>`, is derived). Twin of `EndpointSubkind`.
 * `system` — the machine itself (its FlowPad app, the hub's MCP servers); `admin` / `app` — the project's
 * operator and end-user web proxies, at most ONE of each per placement.
 */
export type EndpointSubkind = 'system' | 'admin' | 'app' | 'agent' | 'service';

/** The two audiences a project's web apps are served to. */
export type WebAudience = 'admin' | 'app';
export const WEB_AUDIENCES: readonly WebAudience[] = ['admin', 'app'];

/** What an endpoint speaking `protocolKind` is for, when a row does not say. Twin of `default_subkind`. */
export function defaultSubkind(protocolKind: string): EndpointSubkind {
  const kind = normalizeKind(protocolKind);
  if (kind === PROTOCOL_WORKSPACE) return 'system';
  if (kind === PROTOCOL_API_CHAT_OPENAI) return 'agent';
  return surfaceOf(kind) === 'web' ? 'app' : 'service';
}

/** How to tell a service is alive. Twin of `HealthCheck` in `flow_sdk/schema/data_spec/health_spec.py`. */
export type HealthCheck = { type: 'http'; path: string } | { type: 'command'; cmd: string } | { type: 'builtin' };

export type HealthState = 'alive' | 'failing' | 'starting' | 'unknown';

/** What one check of one service found (`health.endpoint`). */
export interface EndpointHealth {
  endpoint_id: string;
  name: string;
  state: HealthState;
  observed_at: string;
  detail: string;
  latency_ms?: number | null;
}

/** Every service on one machine, checked together (`health.node`). */
export interface NodeHealth {
  node_id: string;
  observed_at: string;
  endpoints: EndpointHealth[];
}

/** Worst first: a node or deployment is as healthy as its least healthy service. */
const STATE_ORDER: HealthState[] = ['failing', 'unknown', 'starting', 'alive'];

/** The least healthy of `states`; `unknown` when there are none. Twin of `worst` in `health_spec.py`. */
export function worstHealth(states: Iterable<HealthState>): HealthState {
  const seen = new Set(states);
  return STATE_ORDER.find((s) => seen.has(s)) ?? 'unknown';
}

export interface IServiceEndpoint extends Omit<IEntity, 'status'> {
  name: string;
  /** What it is for: system, admin, app, agent or service. */
  subkind?: EndpointSubkind;
  protocol: ServiceProtocol;
  backend: ServiceBackend;
  supports_direct_access?: boolean;
  status?: DeploymentStatus;
  project_id?: string | null;
  /** The app this serves, when it serves one — a reference, like `Deployment.artifact_id`. */
  artifact_id?: string | null;
  /** The webapp definition (`micro_app`) it serves, when it serves one. */
  webapp_id?: string | null;
  /** How to tell it is alive; absent = the default for its backend. */
  check?: HealthCheck | null;
  /** What the last health check found. */
  health?: EndpointHealth | null;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ServiceEndpoint extends EntityMerge<IServiceEndpoint> {}

/**
 * ServiceEndpoint — one service a Deployment exposes. Child of its Deployment.
 *
 * Two axes: `protocol` says what it SPEAKS (`web.app`, `api.chat.openai`, …),
 * `backend` says how this machine produces the bytes (static files or a process on
 * a port). Held at the same id on the hub and here; `serviceUrl` is the path both
 * tiers proxy, and `directUrl()` asks for the service's own address at call time —
 * it is never stored.
 */
/**
 * `…/service_endpoint/<id>/service/<path>` for an endpoint known only by id (a viewer's module).
 * `route` is the app's mount on an audience proxy: its files live one segment down.
 */
export function serviceUrlOf(endpointId: string, path: string = '', route?: string | null): string {
  const base = new ActionInfo('service', 'service_endpoint', endpointId).fullActionUrl.replace(/\/+$/, '');
  const mount = route ? `${encodeURIComponent(route)}/` : '';
  return `${base}/${mount}${path.replace(/^\/+/, '')}`;
}

/**
 * One app as it is served on a placement — what a display loads, probes and repairs.
 *
 * An app is a ROUTE of its placement's audience proxy (`mount` on `endpoint`), so its address is
 * the pair; a service that is an endpoint of its own has no mount (`null`). Either way `backend`
 * is how ITS bytes are produced: a folder, or a process on a port.
 */
export class ServedApp {
  constructor(
    readonly endpoint: ServiceEndpoint,
    readonly mount: string | null,
  ) {}

  /** The proxy's id — with `mount`, the app's address. */
  get id(): string {
    return this.endpoint.id;
  }

  get route(): RouteSpec | null {
    const backend = this.endpoint.backend;
    return backend.type === 'routed' && this.mount !== null ? (backend.routes[this.mount] ?? null) : null;
  }

  get backend(): StaticBackend | ProxyBackend | ChannelBackend | null {
    const backend = this.endpoint.backend;
    return backend.type === 'routed' ? (this.route?.backend ?? null) : backend;
  }

  get webapp_id(): string | null {
    return (this.mount === null ? this.endpoint.webapp_id : this.route?.webapp_id) ?? null;
  }

  get artifact_id(): string | null {
    return (this.mount === null ? this.endpoint.artifact_id : this.route?.artifact_id) ?? null;
  }

  get project_id(): string | null {
    return this.endpoint.project_id;
  }

  get remote(): boolean {
    return !!this.endpoint.remote;
  }

  get name(): string {
    return this.mount || this.endpoint.name;
  }

  /** The proxied address of the app's own root — `…/service/<mount>/<path>`. */
  serviceUrl(path: string = ''): string {
    return serviceUrlOf(this.endpoint.id, path, this.mount);
  }

  /** The app's own address (a dev server's), resolved now. */
  directUrl(): Promise<string> {
    return this.endpoint.directUrl(this.mount);
  }

  /** What is wrong with the app's process, asked of the machine it runs on. */
  probe<T = Record<string, unknown>>(): Promise<T> {
    return this.endpoint.probe<T>(this.mount);
  }
}

@registerEntity
export class ServiceEndpoint extends APIEntity<ServiceEndpoint> implements IServiceEndpoint {
  static type: string = 'service_endpoint';

  name: string;
  subkind: EndpointSubkind;
  protocol: ServiceProtocol;
  backend: ServiceBackend;
  supports_direct_access: boolean;
  status: DeploymentStatus;
  project_id: string | null;
  artifact_id: string | null;
  webapp_id: string | null;
  check: HealthCheck | null;
  health: EndpointHealth | null;

  constructor(entity: Partial<IServiceEndpoint> | IEntity = {}) {
    super(entity);
    const endpoint = entity as Partial<IServiceEndpoint>;
    this.name = endpoint.name ?? '';
    if (!endpoint.protocol || !endpoint.protocol.spec_kind) {
      throw new Error('Invalid ServiceEndpoint structure: protocol.spec_kind is required');
    }
    this.protocol = { ...endpoint.protocol, spec_kind: normalizeKind(endpoint.protocol.spec_kind) };
    this.subkind = endpoint.subkind ?? defaultSubkind(this.protocol.spec_kind);
    this.backend = normalizeBackend(endpoint.backend);
    this.supports_direct_access = endpoint.supports_direct_access ?? false;
    this.status = {
      sync_state: endpoint.status?.sync_state ?? 'current',
      provider_state: endpoint.status?.provider_state ?? null,
      observed_at: endpoint.status?.observed_at ?? null,
      message: endpoint.status?.message ?? null,
    };
    this.project_id = endpoint.project_id ?? null;
    this.artifact_id = endpoint.artifact_id ?? null;
    this.webapp_id = endpoint.webapp_id ?? null;
    this.check = endpoint.check ?? null;
    this.health = endpoint.health ?? null;
    if (!isNonEmptyString(this.name)) throw new Error('Invalid ServiceEndpoint structure: name is required');
  }

  get kind(): string {
    return this.protocol.spec_kind;
  }

  get surface(): 'web' | 'api' {
    return surfaceOf(this.kind);
  }

  /** The proxied address, `…/service_endpoint/<id>/service/<path>` — the same on every tier. */
  serviceUrl(path: string = ''): string {
    return serviceUrlOf(this.id, path);
  }

  /**
   * The apps this endpoint serves: every route of an audience proxy, or — for an endpoint that is a
   * service of its own — itself.
   */
  served(): ServedApp[] {
    if (this.backend.type !== 'routed') return [new ServedApp(this, null)];
    return Object.keys(this.backend.routes).map((mount) => new ServedApp(this, mount));
  }

  /** The app at `mount` of an audience proxy, or null when it routes none there. */
  servedAt(mount: string | null | undefined): ServedApp | null {
    if (this.backend.type !== 'routed') return new ServedApp(this, null);
    const key = mount ?? '';
    return key in this.backend.routes ? new ServedApp(this, key) : null;
  }

  /** What is wrong with the service, asked of the machine it runs on. `route`: an audience proxy's mount. */
  async probe<T = Record<string, unknown>>(route?: string | null): Promise<T> {
    const info = new ActionInfo('probe', this.getType(), this.id, 'POST' as HttpMethod);
    if (route !== null && route !== undefined) info.queryParameters = { route };
    return (await dataManager.callAction<undefined, T>(info)) as T;
  }

  /** Check the service now, where it runs; the result is also recorded on the row. */
  async healthCheck(): Promise<EndpointHealth> {
    return (await this.get<EndpointHealth>('health')) as EndpointHealth;
  }

  /** The service's own address, resolved now (and waking its machine). Never stored. `route`: an
   *  audience proxy's mount — the app whose process is asked for. */
  async directUrl(route?: string | null): Promise<string> {
    const query = route !== null && route !== undefined ? { route } : undefined;
    const data = await this.get<{ url?: string } | null>('direct-url', query);
    if (!data?.url) throw new Error(`service endpoint ${this.name} returned no direct url`);
    return data.url;
  }
}

function normalizeBackend(backend: ServiceBackend | undefined): ServiceBackend {
  if (!backend) throw new Error('Invalid ServiceEndpoint structure: backend is required');
  if (backend.type === 'static') {
    if (!isNonEmptyString(backend.root)) throw new Error('Invalid ServiceEndpoint structure: backend.root is required');
    return { type: 'static', root: backend.root };
  }
  if (backend.type === 'channel') {
    if (!isNonEmptyString(backend.data_source_id)) {
      throw new Error('Invalid ServiceEndpoint structure: backend.data_source_id is required');
    }
    return { type: 'channel', data_source_id: backend.data_source_id };
  }
  if (backend.type === 'proxy') {
    const port = Number(backend.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid ServiceEndpoint structure: backend.port out of range: ${backend.port}`);
    }
    return { type: 'proxy', port, start_cmd: backend.start_cmd ?? null, health: backend.health ?? '/' };
  }
  if (backend.type === 'routed') {
    const routes: Record<string, RouteSpec> = {};
    for (const [mount, route] of Object.entries(backend.routes ?? {})) {
      const inner = normalizeBackend(route?.backend);
      if (inner.type !== 'static' && inner.type !== 'proxy') {
        throw new Error(`Invalid ServiceEndpoint structure: route ${mount} must serve files or a process`);
      }
      routes[mount] = { backend: inner, webapp_id: route.webapp_id ?? null, artifact_id: route.artifact_id ?? null };
    }
    return { type: 'routed', routes };
  }
  throw new Error(`Invalid ServiceEndpoint structure: unknown backend type ${(backend as { type?: string }).type}`);
}

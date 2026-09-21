import { APIEntity, isNonEmptyString, registerEntity } from '../APIEntity';
import type { IEntity, EntityMerge } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
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

export type ServiceBackend = StaticBackend | ProxyBackend;

export interface IServiceEndpoint extends Omit<IEntity, 'status'> {
  name: string;
  protocol: ServiceProtocol;
  backend: ServiceBackend;
  supports_direct_access?: boolean;
  status?: DeploymentStatus;
  project_id?: string | null;
  /** The app this serves, when it serves one — a reference, like `Deployment.artifact_id`. */
  artifact_id?: string | null;
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
@registerEntity
export class ServiceEndpoint extends APIEntity<ServiceEndpoint> implements IServiceEndpoint {
  static type: string = 'service_endpoint';

  name: string;
  protocol: ServiceProtocol;
  backend: ServiceBackend;
  supports_direct_access: boolean;
  status: DeploymentStatus;
  project_id: string | null;
  artifact_id: string | null;

  constructor(entity: Partial<IServiceEndpoint> | IEntity = {}) {
    super(entity);
    const endpoint = entity as Partial<IServiceEndpoint>;
    this.name = endpoint.name ?? '';
    if (!endpoint.protocol || !endpoint.protocol.spec_kind) {
      throw new Error('Invalid ServiceEndpoint structure: protocol.spec_kind is required');
    }
    this.protocol = { ...endpoint.protocol, spec_kind: normalizeKind(endpoint.protocol.spec_kind) };
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
    const base = new ActionInfo('service', ServiceEndpoint.type, this.id).fullActionUrl.replace(/\/+$/, '');
    const sub = path.replace(/^\/+/, '');
    return `${base}/${sub}`;
  }

  /** The service's own address, resolved now (and waking its machine). Never stored. */
  async directUrl(): Promise<string> {
    const data = await this.get<{ url?: string } | null>('direct-url');
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
  if (backend.type === 'proxy') {
    const port = Number(backend.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid ServiceEndpoint structure: backend.port out of range: ${backend.port}`);
    }
    return { type: 'proxy', port, start_cmd: backend.start_cmd ?? null, health: backend.health ?? '/' };
  }
  throw new Error(`Invalid ServiceEndpoint structure: unknown backend type ${(backend as { type?: string }).type}`);
}

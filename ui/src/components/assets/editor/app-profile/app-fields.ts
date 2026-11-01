/**
 * The shape of `webapp.json` the app editor reads and writes — the twin of `WebappManifestSpec`
 * (`flow_sdk/schema/data_spec/webapp_spec.py`). Pure helpers: every edit returns a NEW value for one
 * top-level field (`mounts`, `services`), which the editor saves as one document patch; the backend
 * validates it against the spec and refuses a bad one.
 */

import type { WebAudience } from '@sdk';

export type Audience = WebAudience;

export interface PortSpec {
  port: number;
  required?: boolean;
}

export interface ProxyServing {
  type: 'proxy';
  start_cmd: string;
  health?: string;
  ports?: { local?: PortSpec | null } | null;
  /** The older spelling of `ports.local.port` (required); still read, rewritten on edit. */
  port?: number | null;
  install_cmd?: string;
  install_check?: string;
  build_cmd?: string;
}

export interface StaticServing {
  type: 'static';
  root?: string;
}

export type Serving = ProxyServing | StaticServing;

export interface Mount {
  audience?: Audience;
  /** `''` is the audience's home page; absent is the app's own name. */
  path?: string | null;
  serving?: Serving;
}

export interface Service {
  name: string;
  protocol: { spec_kind: string; [key: string]: unknown };
  serving: ProxyServing;
}

/** `MOUNT_PATTERN` in `service_endpoint_spec.py`: one URL segment, or empty. */
export const MOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$|^$/;

const STATIC: StaticServing = { type: 'static', root: '' };

/** The mounts a placement serves: the declared ones, or the one implicit static mount
 *  (`effective_mounts`) — none for an app that only declares services. */
export function effectiveMounts(mounts: Mount[] | undefined, services: Service[] | undefined): Mount[] {
  if (mounts?.length) return mounts;
  return services?.length ? [] : [{ audience: 'app', serving: STATIC }];
}

export function servingOf(mount: Mount): Serving {
  return mount.serving ?? STATIC;
}

/** The port a process declares, whichever way it is spelled; null when it declares none. */
export function declaredPort(serving: ProxyServing): PortSpec | null {
  const local = serving.ports?.local;
  if (local) return { port: local.port, required: local.required ?? true };
  return serving.port ? { port: serving.port, required: true } : null;
}

/** The serving with its port set — always written as `ports.local`, the spelling the spec prefers. */
export function withPort(serving: ProxyServing, port: PortSpec | null): ProxyServing {
  const { port: _legacy, ports: _ports, ...rest } = serving;
  return port ? { ...rest, ports: { local: { port: port.port, required: port.required ?? true } } } : rest;
}

/** Switching how a process runs keeps only what the new way has: the spec allows one or the other. */
export function switchServing(serving: Serving, to: Serving['type']): Serving {
  if (serving.type === to) return serving;
  return to === 'static' ? { ...STATIC } : { type: 'proxy', start_cmd: '' };
}

export function replaceAt<T>(list: T[], index: number, next: T): T[] {
  return list.map((item, i) => (i === index ? next : item));
}

/** The mount at `path`: `''` is the audience's home page, undefined its own name (the key is dropped). */
export function withPath(mount: Mount, path: string | undefined): Mount {
  const { path: _path, ...rest } = mount;
  return path === undefined ? rest : { ...rest, path };
}

/** Where the app opens under its audience: `/` for the home page, else `/<path or name>/`. */
export function addressOf(mount: Mount, appName: string): string {
  if (mount.path === '') return '/';
  return `/${mount.path || appName}/`;
}

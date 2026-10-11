/**
 * Compute node type definitions — enums and interfaces for compute provider config.
 *
 * THE LAYERING RULE THIS FILE ESTABLISHES, stated once for every `*-types.ts` sibling:
 *
 * A row's WIRE SHAPE lives below the entity classes; nothing below the classes may
 * name a class. `APIEntity` is the base of every entity, so if a lower layer (a
 * bootstrap payload, the store, a page DTO) can only reach a shape THROUGH the module
 * that also declares `class X extends APIEntity`, the base class ends up loading its
 * own subclasses. The loader then has to hand someone a half-built module, and
 * `extends` evaluates against `undefined`. Splitting the shape out is what keeps the
 * graph acyclic; the class module re-exports it, so importers are unaffected.
 *
 * Enforced by `ui/tests/unit/sdk-module-layering.test.ts`.
 */
import { IEntity } from '../../IEntity';

/**
 * Available compute provider types.
 */
export enum ComputeProviderType {
  LOCAL_MACHINE = 'local_machine',
  E2B = 'e2b',
  GCP_VM = 'gcp_vm',
  /** A machine its owner enrolled with `flow connect`; driven by the hub over WS. */
  USER_MACHINE = 'user_machine',
}

/**
 * The providers that can host a cloud SANDBOX — a box a person opens and works
 * in. Every other provider (today only the local machine) can hold compute
 * nodes, but never one of these.
 *
 * An allow-list rather than `!== LOCAL_MACHINE`, because the provider is read
 * tolerantly off the wire and may be absent or unrecognized; "not local" would
 * answer YES to those, and a node with no provider at all would classify as a
 * sandbox. Adding a provider means adding it here — one edit, and both the
 * read side (`ComputeNode.isSandbox`) and the write side (the sandbox hook's
 * default) follow.
 */
export const SANDBOX_PROVIDERS: ReadonlySet<string> = new Set<string>([
  ComputeProviderType.E2B,
  ComputeProviderType.GCP_VM,
  ComputeProviderType.USER_MACHINE,
]);

/**
 * Runtime types for compute environments.
 */
export enum RuntimeType {
  VM = 'VM_RUNTIME',
  DOCKER = 'DOCKER_RUNTIME',
  PROCESS = 'PROCESS_RUNTIME',
}

/**
 * Supported operating system types.
 */
export enum OSType {
  LINUX = 'Linux',
  UBUNTU = 'Ubuntu',
  DEBIAN = 'DEBIAN',
  CENTOS = 'CENTOS',
  ALPINE = 'ALPINE',
  WINDOWS = 'Windows',
  MACOS = 'macOS',
}

/**
 * Compute node execution environment status.
 */
export enum ExecutionEnvironmentStatus {
  NEW = 'NEW',
  READY = 'READY',
  PAUSED = 'PAUSED',
  ERROR = 'ERROR',
  NOT_FOUND = 'NOT_FOUND',
}

/**
 * Runtime environment configuration.
 */
export interface RuntimeEnvironment {
  name: string;
  description?: string;
  os_type?: OSType;
  os_version?: string;
}

/**
 * What a node's backing machine is doing — the answer to `ops/status`.
 *
 * Normalized SERVER-side (`NodeStatus` in the hub) rather than being whatever
 * dict the provider happened to return. Before that, this type was by
 * construction one provider's field set unioned with another's: the hub's own
 * docstring said "and for E2B also started_at/end_at/cpu_count/memory_mb", and
 * the browser consumed it untyped.
 *
 * The optional fields are optional because a provider that cannot answer
 * cheaply must be allowed to say nothing — `undefined` means unknown, never zero.
 */
export interface NodeStatus {
  status: ExecutionEnvironmentStatus;
  /** Start of the CURRENT run. Resets on resume. */
  started_at?: string | null;
  /** When the machine auto-pauses or expires. */
  end_at?: string | null;
  cpu_count?: number;
  memory_mb?: number;
}

/**
 * The answer to `ops/workspace-ready`: the app inside the box is up, and who it
 * is signed in as.
 *
 * `login_detail` is read back FROM the box, not the identity the hub asked for —
 * the two used to be the same value, which is how a box signed in as the wrong
 * person went unnoticed.
 */
export interface WorkspaceReady {
  healthy: boolean;
  started_fallback?: boolean;
  port?: number;
  logged_in: boolean;
  login_detail: string;
}

/**
 * The answer to `ops/upgrade-app`: the app inside the box was reinstalled from
 * PyPI and started again.
 *
 * `version` is read back FROM the box after the restart — it is the build the
 * machine now runs, not the one the hub asked pip for, and it is optional
 * because a box that upgraded fine but did not answer the follow-up read must
 * still report success.
 */
export interface AppUpgrade {
  upgraded: boolean;
  /** The running version, or absent when the box did not report one. */
  version?: string | null;
  /** Did the app come back up after the upgrade? */
  healthy: boolean;
  /** Tail of the pip/CLI output, so "already the latest" is tellable from
   *  "fetched a new one" without opening a terminal on the box. */
  output?: string;
}

/** A project to clone onto the box and add as a dependency of the main one. */
export interface ProvisionContextProject {
  git_origin: Record<string, unknown>;
  name: string;
  /** True files it under `optionalDependencies`; false (the default) is required. */
  optional?: boolean;
}

/** A project provisioned on the box BESIDE the main one — its own project, never attached
 *  (a launch's controller). Keeps `project_id`, so one id spans hub and box. */
export interface ProvisionCompanion {
  git_origin: Record<string, unknown>;
  name: string;
  project_id?: string;
}

/**
 * What `ops/provision-project` sets a box up with — the creator's recorded
 * choice. No `git_origin` mounts an empty project; no `context_projects` means
 * whatever the cloned repo's own manifest declares.
 */
export interface ProvisionSetup {
  name: string;
  project_id?: string;
  git_origin?: Record<string, unknown>;
  context_projects?: ProvisionContextProject[];
  companions?: ProvisionCompanion[];
  install?: Record<string, unknown>;
}

/** One step of a provisioning run, in the order it ran. */
export interface ProvisionStep {
  id: 'validate' | 'clone' | 'init' | 'index' | 'companion' | 'context' | 'default';
  ok: boolean;
  detail: string;
}

/** What `ops/provision-project` answers: the box's project and each step's outcome. */
export interface ProvisionResult {
  project?: { id: string; name?: string };
  path?: string;
  install_result?: unknown;
  steps: ProvisionStep[];
  [key: string]: unknown;
}

/**
 * Interface for ComputeNode entity data.
 *
 * `status` is omitted from the base: a compute_node row has no persisted status
 * field, and the name is taken on the class by the async `status()` call that
 * asks the provider what the machine is doing.
 */
export interface IComputeNode extends Omit<IEntity, 'status'> {
  name: string;
  runtime: RuntimeEnvironment;
  node_provider_type?: ComputeProviderType;
  node_provider_id?: string;
  node_config?: Record<string, unknown>;
  fs_storage_mount_path?: string | null;
  home_dir?: string | null;
  /** Whether the box belongs to a single person. Owner-only to change, and only
   *  through the hub's `auto-login` action — it is in the hub's
   *  `_immutable_update`, so a PUT carrying it is silently dropped. */
  auto_login?: boolean;
  /** Who the box last reported itself signed in as, cached hub-side. `null` (or
   *  absent) means "not signed in as far as the hub knows", which includes
   *  "never looked". Read-only: server-owned, never sent. */
  logged_in_user?: string | null;
}

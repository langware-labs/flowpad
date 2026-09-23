import { APIEntity, isNonEmptyString, registerEntity } from '../APIEntity';
import type { IEntity, EntityMerge } from '../IEntity';
import { DockPointerData } from '../models/DockPointer';
import { normalizeKind } from '../models/Kind';
import { isTypeId, TypeId } from '../models/TypeId';
import { ViewType } from '../utils/ui/view-types';
import { WorldViewProjection } from '../worldview/projection';
import { DEFAULT_CREDENTIAL_ENVIRONMENT } from '../services/credentials-service';
import { ServiceEndpoint, type IServiceEndpoint } from './service-endpoint';

export type ArtifactLinkSource = 'manual' | 'gcp_label';
export type DeploymentSyncState = 'current' | 'stale' | 'partial' | 'error';
export type DeploymentObservationKind = 'cost' | 'size' | 'activity';
export type ObservationCoverage = 'available' | 'unavailable' | 'unattributed' | 'stale';

/** What is placed. WHERE it runs is `target.provider` — two axes, two fields. */
export const KIND_AGENT = 'runtime.agent';
export const KIND_WEB = 'runtime.web';
export const KIND_NODE = 'compute.node';

/**
 * Providers that place a resource on a ComputeNode, so `origin.external_id`
 * names that node. An inventoried `gcp` resource is not node-backed — its
 * `external_id` is the provider's own resource name.
 */
export const NODE_PROVIDERS: ReadonlySet<string> = new Set(['local', 'local_machine', 'e2b', 'docker', 'gcp_vm', 'user_machine']);

/** Provider-normalized signal; unavailable data is represented explicitly, never as zero. */
export interface DeploymentObservation {
  metric: string;
  coverage: ObservationCoverage;
  value?: number | null;
  unit?: string | null;
  observed_at: string;
  window_start?: string | null;
  window_end?: string | null;
  source: string;
}

/** Provider-neutral placement coordinates. */
export interface DeploymentTarget {
  provider: string;
  scope: string;
  location?: string | null;
}

/**
 * Where this record's truth lives — the cloud resource being placed.
 *
 * Not a `CloudOrigin` (a record identity has a key from birth): a placement exists
 * before it is placed, so `external_id` stays empty until a node is allocated. Twin of
 * `PlacementOrigin` in `flow_sdk/builtin/deployment.py`. `external_id` is the ComputeNode
 * typeid for a node-backed placement, or the provider's own resource name for an
 * inventoried one.
 */
export interface PlacementOrigin {
  kind: string;
  provider: string;
  external_id: string;
  url?: string;
}

export interface DeploymentStatus {
  sync_state: DeploymentSyncState;
  provider_state?: string | null;
  observed_at?: string | null;
  message?: string | null;
}

export interface IDeployment extends Omit<IEntity, 'status'> {
  name: string;
  kind: string;
  artifact_id?: string | null;
  artifact_link_source?: ArtifactLinkSource | null;
  target: DeploymentTarget;
  origin?: PlacementOrigin | null;
  status: DeploymentStatus;
  provider_labels: Record<string, string>;
  observations: Partial<Record<DeploymentObservationKind, DeploymentObservation>>;
  source_revision?: string | null;
  project_id?: string | null;
  /** Credential environment: `development` (this computer) or a named one (`production`, `staging`, …). */
  environment?: string;
}

// `implements IDeployment` only checks the class; it contributes no members, so every
// field declared solely on IDeployment read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Deployment extends EntityMerge<IDeployment> {}

/** One thing that happened on a deployment — mirror of `deployment.timeline_event`. */
export interface TimelineEvent {
  at: string;
  kind: 'message_in' | 'reply_sent' | 'turn_started' | 'turn_failed' | 'refused';
  who: string;
  text: string;
  channel: string;
  data_source_id: string;
  process_id: string;
  conversation_id: string;
  message_id: string;
}

/** A page of a deployment's timeline, newest first — mirror of `deployment.timeline`. */
export interface DeploymentTimeline {
  deployment_id: string;
  events: TimelineEvent[];
  before: string | null;
}

/**
 * One conversation a deployment holds — a chat, a mail thread, a whole phone call — mirror of
 * `deployment.thread`. `status`: `live` (a call is on the line), `working` (the agent is mid-turn),
 * `ended` (a call that is over), `idle`.
 */
export interface DeploymentThread {
  conversation_id: string;
  title: string;
  who: string;
  channel: string;
  data_source_id: string;
  process_id: string;
  status: 'live' | 'working' | 'ended' | 'idle';
  started_at: string | null;
  last_at: string | null;
  last_text: string;
  messages: number;
  turns: number;
}

/** The tag a deployment's process emits when its timeline moved (relayed to the app). */
export const DEPLOYMENT_TIMELINE_TAG = 'deployment.timeline';

/**
 * Deployment is THE placement record: this thing runs on that machine.
 *
 * Two axes, each declared once — `kind` says WHAT is placed (`runtime.agent`,
 * `runtime.web`, `compute.node`), `target.provider` says WHERE (`local`, `e2b`,
 * `gcp`). The row is parented to the deployed element and holds the same id on
 * the hub and here, so a cloud placement is adopted rather than re-minted.
 */
@registerEntity
export class Deployment extends APIEntity<Deployment> implements IDeployment {
  static type: string = 'deployment';

  name: string;
  kind: string;
  artifact_id: string | null;
  artifact_link_source: ArtifactLinkSource | null;
  target: DeploymentTarget;
  origin: PlacementOrigin | null;
  status: DeploymentStatus;
  provider_labels: Record<string, string>;
  observations: Partial<Record<DeploymentObservationKind, DeploymentObservation>>;
  source_revision: string | null;
  project_id: string | null;
  environment: string;

  constructor(entity: Partial<IDeployment> | IEntity = {}) {
    super(entity);
    const deployment = entity as Partial<IDeployment>;
    this.name = deployment.name ?? '';
    if (!deployment.kind) throw new Error('Invalid Deployment structure: kind is required');
    this.kind = normalizeKind(deployment.kind);
    this.artifact_id = deployment.artifact_id ?? null;
    this.artifact_link_source = deployment.artifact_link_source ?? null;
    this.target = {
      provider: deployment.target?.provider ?? '',
      scope: deployment.target?.scope ?? '',
      location: deployment.target?.location ?? null,
    };
    this.origin = deployment.origin
      ? {
          kind: deployment.origin.kind ?? '',
          provider: deployment.origin.provider ?? '',
          external_id: deployment.origin.external_id ?? '',
          url: deployment.origin.url ?? '',
        }
      : null;
    this.status = {
      sync_state: deployment.status?.sync_state ?? 'current',
      provider_state: deployment.status?.provider_state ?? null,
      observed_at: deployment.status?.observed_at ?? null,
      message: deployment.status?.message ?? null,
    };
    this.provider_labels = normalizeProviderLabels(deployment.provider_labels);
    this.observations = normalizeObservations(deployment.observations);
    this.source_revision = deployment.source_revision ?? null;
    this.project_id = deployment.project_id ?? null;
    this.environment = deployment.environment || DEFAULT_CREDENTIAL_ENVIRONMENT;
    this.validateStructure();
  }

  override get dockPointer(): DockPointerData {
    return new DockPointerData(ViewType.WORLDVIEW, WorldViewProjection.DEPLOYMENT, {
      focus: `${Deployment.type}-${this.id}`,
      selected: `${Deployment.type}-${this.id}`,
    });
  }

  /** The Agent this places, or null when the deployed element is something else. */
  get agentTypeId(): TypeId | null {
    const parent = this.parent_type_id;
    if (!parent || !isTypeId(parent)) return null;
    const typeId = new TypeId(parent);
    return typeId.type === 'agent' ? typeId : null;
  }

  /** The machine this runs on, or null when the placement is not node-backed. */
  get computeNodeTypeId(): string | null {
    if (!NODE_PROVIDERS.has(this.target.provider)) return null;
    return this.origin?.external_id || null;
  }

  /**
   * Stop the machine, keep the row.
   *
   * Terminate is a pause: this row carries the placement's cost and activity
   * observations, and deleting it throws away the only record of what the box
   * cost. Deleting a Deployment destroys a real cloud resource, which is why
   * that path warns and this one does not.
   */
  async pause(): Promise<Deployment> {
    return new Deployment((await this.post('pause')) as IDeployment);
  }

  /** Start a paused machine again. */
  async resume(): Promise<Deployment> {
    return new Deployment((await this.post('resume')) as IDeployment);
  }

  /** Bring a cloud machine to the published definition (the hub re-clones and re-indexes it). */
  async update(): Promise<Record<string, unknown>> {
    return ((await this.post('update')) ?? {}) as Record<string, unknown>;
  }

  /** What this placement serves — for a cloud placement, as the hub has it now (held here at the hub's ids). */
  async endpoints(): Promise<ServiceEndpoint[]> {
    const data = await this.get<{ endpoints?: IServiceEndpoint[] } | null>('endpoints');
    return (data?.endpoints ?? []).map((row) => new ServiceEndpoint(row));
  }

  /**
   * What reached this deployment, what it ran and what it answered — newest first
   * (`GET deployment/<id>/timeline`); `conversation` narrows it to one thread, `before` pages back.
   */
  async timeline(
    opts: { limit?: number; before?: string | null; conversation?: string | null } = {},
  ): Promise<DeploymentTimeline> {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.before) params.set('before', opts.before);
    if (opts.conversation) params.set('conversation', opts.conversation);
    const qs = params.toString();
    const data = await this.get<DeploymentTimeline | null>(`timeline${qs ? `?${qs}` : ''}`);
    return data ?? { deployment_id: this.id, events: [], before: null };
  }

  /** The conversations it holds, the active ones first (`GET deployment/<id>/threads`). */
  async threads(): Promise<DeploymentThread[]> {
    const data = await this.get<{ threads?: DeploymentThread[] } | null>('threads');
    return data?.threads ?? [];
  }

  /** The latest runs on a cloud machine, read through the hub. This computer's runs are the local run list. */
  async runs<T = Record<string, unknown>>(limit: number): Promise<T[]> {
    const data = await this.get<{ runs?: T[] } | null>(`runs?limit=${encodeURIComponent(String(limit))}`);
    return data?.runs ?? [];
  }

  private validateStructure(): void {
    const errors: string[] = [];
    if (!isNonEmptyString(this.name)) errors.push('name is required');
    if (!isNonEmptyString(this.target.provider)) errors.push('target.provider is required');
    if (!isNonEmptyString(this.target.scope)) errors.push('target.scope is required');
    if (!['current', 'stale', 'partial', 'error'].includes(this.status.sync_state)) {
      errors.push(`invalid status.sync_state: ${this.status.sync_state}`);
    }
    if (this.artifact_link_source && !['manual', 'gcp_label'].includes(this.artifact_link_source)) {
      errors.push(`invalid artifact_link_source: ${this.artifact_link_source}`);
    }
    if (errors.length > 0) {
      throw new Error(`Invalid Deployment structure: ${errors.join(', ')}`);
    }
  }
}

function normalizeObservations(
  observations: Partial<Record<DeploymentObservationKind, DeploymentObservation>> | undefined,
): Partial<Record<DeploymentObservationKind, DeploymentObservation>> {
  if (observations === undefined) return {};
  if (!observations || Array.isArray(observations) || typeof observations !== 'object') {
    throw new Error('Invalid Deployment structure: observations must be an object');
  }
  const normalized: Partial<Record<DeploymentObservationKind, DeploymentObservation>> = {};
  const supportedKinds = new Set<DeploymentObservationKind>(['cost', 'size', 'activity']);
  for (const key of Object.keys(observations)) {
    if (!supportedKinds.has(key as DeploymentObservationKind)) {
      throw new Error(`Invalid Deployment structure: invalid observation kind: ${key}`);
    }
  }
  for (const kind of ['cost', 'size', 'activity'] as const) {
    const observation = observations[kind];
    if (!observation || typeof observation !== 'object') continue;
    const coverage = observation.coverage ?? 'available';
    const value = observation.value ?? null;
    const hasValue = typeof value === 'number' && Number.isFinite(value);
    if (!['available', 'unavailable', 'unattributed', 'stale'].includes(coverage)) {
      throw new Error(`Invalid Deployment structure: invalid observations.${kind}.coverage: ${coverage}`);
    }
    if ((coverage === 'available' || coverage === 'stale') && (!hasValue || !isNonEmptyString(observation.unit))) {
      throw new Error(`Invalid Deployment structure: observations.${kind} requires a finite value and unit`);
    }
    if ((coverage === 'unavailable' || coverage === 'unattributed') && observation.value != null) {
      throw new Error(`Invalid Deployment structure: observations.${kind} must not carry a value`);
    }
    if (!isNonEmptyString(observation.observed_at) || !isNonEmptyString(observation.source)) {
      throw new Error(`Invalid Deployment structure: observations.${kind} requires observed_at and source`);
    }
    if (!isNonEmptyString(observation.metric)) {
      throw new Error(`Invalid Deployment structure: observations.${kind} requires metric`);
    }
    const observedAt = normalizeTimestamp(observation.observed_at, `observations.${kind}.observed_at`);
    const source = observation.source.trim();
    const unit = normalizeOptionalText(observation.unit, `observations.${kind}.unit`);
    const windowStart = normalizeOptionalTimestamp(observation.window_start, `observations.${kind}.window_start`);
    const windowEnd = normalizeOptionalTimestamp(observation.window_end, `observations.${kind}.window_end`);
    if ((windowStart === null) !== (windowEnd === null)) {
      throw new Error(`Invalid Deployment structure: observations.${kind} window requires both endpoints`);
    }
    if (windowStart && windowEnd && Date.parse(windowStart) >= Date.parse(windowEnd)) {
      throw new Error(`Invalid Deployment structure: observations.${kind} window_start must be before window_end`);
    }
    if ((kind === 'cost' || kind === 'activity') && (!windowStart || !windowEnd)) {
      throw new Error(`Invalid Deployment structure: ${kind} observation requires a declared window`);
    }
    normalized[kind] = {
      metric: normalizeKind(observation.metric),
      coverage,
      value,
      unit,
      observed_at: observedAt,
      window_start: windowStart,
      window_end: windowEnd,
      source,
    };
  }
  return normalized;
}

const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

function normalizeTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid Deployment structure: ${field} must be a string`);
  const timestamp = value.trim();
  const match = RFC3339_PATTERN.exec(timestamp);
  if (!match || !isValidRfc3339Parts(match) || Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`Invalid Deployment structure: ${field} must be RFC3339 with a timezone`);
  }
  return timestamp;
}

function isValidRfc3339Parts(match: RegExpExecArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHour > 23 || offsetMinute > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

function normalizeOptionalTimestamp(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return normalizeTimestamp(value, field);
}

function normalizeOptionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`Invalid Deployment structure: ${field} must be a string`);
  return value.trim() || null;
}

function normalizeProviderLabels(labels: Record<string, string> | undefined): Record<string, string> {
  if (!labels || Array.isArray(labels) || typeof labels !== 'object') return {};
  return Object.fromEntries(
    Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

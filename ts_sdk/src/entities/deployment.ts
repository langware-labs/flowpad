import { APIEntity, dataManager, isNonEmptyString, registerEntity } from '../APIEntity';
import type { IEntity } from '../IEntity';
import { ActionInfo } from '../models';
import { DockPointerData } from '../models/DockPointer';
import { normalizeKind } from '../models/Kind';
import { isTypeId, TypeId } from '../models/TypeId';
import { ViewType } from '../utils/ui/view-types';
import { WorldViewProjection } from '../worldview/projection';

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
export const NODE_PROVIDERS: ReadonlySet<string> = new Set(['local', 'e2b', 'user_machine']);

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
 * The same value object the ingest side uses (`flow_sdk/builtin/cloud_origin.py`):
 * secret-free, no behaviour, just a pointer at a mutable object in someone
 * else's system. `external_id` is the ComputeNode typeid for a node-backed
 * placement, or the provider's own resource name for an inventoried one.
 */
export interface CloudOrigin {
  kind: string;
  provider: string;
  data_source_id?: string;
  source_item_id?: string;
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
  origin?: CloudOrigin | null;
  status: DeploymentStatus;
  provider_labels: Record<string, string>;
  observations: Partial<Record<DeploymentObservationKind, DeploymentObservation>>;
  source_revision?: string | null;
  project_id?: string | null;
}

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
  origin: CloudOrigin | null;
  status: DeploymentStatus;
  provider_labels: Record<string, string>;
  observations: Partial<Record<DeploymentObservationKind, DeploymentObservation>>;
  source_revision: string | null;
  project_id: string | null;

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
          data_source_id: deployment.origin.data_source_id ?? '',
          source_item_id: deployment.origin.source_item_id ?? '',
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
    const action = new ActionInfo('pause', Deployment.type, this.id, 'POST');
    return new Deployment((await dataManager.callAction(action)) as IDeployment);
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

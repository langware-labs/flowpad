import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

/**
 * System-owned first segments — keep in lockstep with
 * `flow_sdk/builtin/topic.py` RESERVED_ROOTS. A non-system actor may not
 * create a topic under these; the backend save gate enforces it, this mirror
 * only lets UI surfaces (e.g. the dev gardening view) decide up front whether
 * a bless must carry `system: true`.
 */
export const RESERVED_TOPIC_ROOTS: ReadonlySet<string> = new Set([
  'entity', 'hub', 'node', 'agent', 'flow', 'app',
  'application', 'workload', 'resource', 'content', 'gcp', 'local',
]);

export interface ITopic extends IEntity {
  /** Canonical dot-separated topic name (the natural key — id is uuid5 of it). */
  name?: string | null;
  /** UX display label. */
  title?: string | null;
  /** What events/things under this topic mean. */
  description?: string | null;
  /** Canonical successor name when this topic was renamed (name IS identity). */
  alias_of?: string | null;
  /** Hidden from authoring surfaces. */
  deprecated?: boolean;
  /** Shipped system-vocabulary topic (seeded; reserved-root enforcement keys off it). */
  system?: boolean;
}

/**
 * A blessed dot-taxonomy topic — OPTIONAL enrichment of a topic name. The
 * system works with anonymous topics (plain strings validated by
 * `topics/grammar`); a Topic entity exists only where a name deserves
 * documentation, display, namespace ownership, or hub sync.
 *
 * Mirrors `flow_sdk.builtin.topic.Topic`. Query via dataManager like any
 * type; the taxonomy tree is derived with `topicTree()` — never stored.
 */
@registerEntity
export class Topic extends APIEntity<Topic> implements ITopic {
  title: string | null = null;
  description: string | null = null;
  alias_of: string | null = null;
  deprecated: boolean = false;
  system: boolean = false;
  static type: string = 'topic';

  constructor(entity: Partial<ITopic> = {}) {
    super(entity);
    this.title = entity.title ?? null;
    this.description = entity.description ?? null;
    this.alias_of = entity.alias_of ?? null;
    this.deprecated = entity.deprecated ?? false;
    this.system = entity.system ?? false;
  }
}

import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

/**
 * System-owned first segments — keep in lockstep with
 * `flow_sdk/builtin/tag.py` RESERVED_ROOTS. A non-system actor may not
 * create a tag under these; the backend save gate enforces it. This mirror
 * only lets UI surfaces suppress an affordance the backend would reject.
 */
export const RESERVED_TAG_ROOTS: ReadonlySet<string> = new Set([
  'entity',
  'hub',
  'node',
  'agent',
  'graph_workflow',
  'app',
  'ingest',
  'application',
  'workload',
  'resource',
  'content',
  'datasource',
  'gcp',
  'runtime',
  'compute',
]);

export interface ITag extends IEntity {
  /** Canonical dot-separated tag name (the natural key — id is uuid5 of it). */
  name?: string | null;
  /** UX display label. */
  title?: string | null;
  /** What events/things under this tag mean. */
  description?: string | null;
  /** Canonical successor name when this tag was renamed (name IS identity). */
  alias_of?: string | null;
  /** Hidden from authoring surfaces. */
  deprecated?: boolean;
  /** Shipped system-vocabulary tag (seeded; reserved-root enforcement keys off it). */
  system?: boolean;
}

// `implements ITag` only checks the class; it contributes no members, so every
// field declared solely on ITag read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Tag extends Omit<ITag, 'expand' | 'id' | 'is_private' | 'members'> {}

/**
 * A blessed dot-taxonomy tag — OPTIONAL enrichment of a tag name. The
 * system works with anonymous tags (plain strings validated by
 * `tags/grammar`); a Tag entity exists only where a name deserves
 * documentation, display, namespace ownership, or hub sync.
 *
 * Mirrors `flow_sdk.builtin.tag.Tag`. Query via dataManager like any
 * type; the taxonomy tree is derived with `tagTree()` — never stored.
 */
@registerEntity
export class Tag extends APIEntity<Tag> implements ITag {
  title: string | null = null;
  description: string | null = null;
  alias_of: string | null = null;
  deprecated: boolean = false;
  system: boolean = false;
  static type: string = 'tag';

  constructor(entity: Partial<ITag> = {}) {
    super(entity);
    this.title = entity.title ?? null;
    this.description = entity.description ?? null;
    this.alias_of = entity.alias_of ?? null;
    this.deprecated = entity.deprecated ?? false;
    this.system = entity.system ?? false;
  }
}

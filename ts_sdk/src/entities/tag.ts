import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';
import { IEntity, EntityMerge } from '../IEntity';
import apiClient from '../client';

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
  'message',
  'application',
  'workload',
  'resource',
  'content',
  'datasource',
  'gcp',
]);

export interface ITag extends IEntity {
  color?: string | null;
  inbox?: boolean;
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
export interface Tag extends EntityMerge<ITag> {}

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
  color: string | null = null;
  inbox = false;
  title: string | null = null;
  description: string | null = null;
  alias_of: string | null = null;
  deprecated: boolean = false;
  system: boolean = false;
  static type: string = 'tag';

  /** Include shipped vocabulary when rendering the optional Flowpad message tags. */
  static async definitions(): Promise<ITag[]> {
    return (await apiClient.get<ITag[]>('/graph/tag', { params: { include_system: true } })) ?? [];
  }

  async renameMessageTag(fields: { name: string; title?: string; description?: string; color?: string }): Promise<void> {
    const action = new ActionInfo('rename-message-tag', Tag.type, this.id, 'POST');
    action.bodyParameters = fields;
    await dataManager.callAction(action);
  }

  async deleteMessageTag(): Promise<void> {
    await dataManager.callAction(new ActionInfo('delete-message-tag', Tag.type, this.id, 'POST'));
  }

  async messageTagImpact(): Promise<{ messages: number; automations: number }> {
    return (await dataManager.callAction<unknown, { messages: number; automations: number }>(new ActionInfo('message-tag-impact', Tag.type, this.id, 'GET')))!;
  }

  constructor(entity: Partial<ITag> = {}) {
    super(entity);
    this.color = entity.color ?? null;
    this.inbox = entity.inbox ?? false;
    this.title = entity.title ?? null;
    this.description = entity.description ?? null;
    this.alias_of = entity.alias_of ?? null;
    this.deprecated = entity.deprecated ?? false;
    this.system = entity.system ?? false;
  }
}

import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

/**
 * Topic — a dot-path named channel in the flow graph (backend:
 * flow_sdk/builtin/topic.py). DB-only; id is deterministic
 * (uuid5 of "topic:<name>") so the same name resolves to the same entity
 * everywhere. Topics form a prefix tree: a listener on "a.b" hears the whole
 * "a.b.*" subtree.
 */
export interface ITopic extends IEntity {
  /** Dot-path topic name, e.g. "report.usage.ready". */
  name?: string;
  description?: string;
  /** Optional hex color for UI rendering. */
  color?: string;
}

@registerEntity
export class Topic extends APIEntity<Topic> implements ITopic {
  name?: string;
  description?: string;
  color?: string;
  static type: string = 'topic';

  constructor(entity: Partial<ITopic> = {}) {
    super(entity);
    this.name = entity.name ?? '';
    this.description = entity.description;
    this.color = entity.color;
  }

  /** The prefix one level up ("a.b" for "a.b.c"), or null at a root. */
  get parentName(): string | null {
    if (!this.name || !this.name.includes('.')) return null;
    return this.name.slice(0, this.name.lastIndexOf('.'));
  }
}

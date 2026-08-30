import type { EntityMerge } from '../IEntity';
import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface IComment extends IEntity {
  raw_content?: string;
  data?: Record<string, any>;
}

// `implements IComment` only checks the class; it contributes no members, so every
// field declared solely on IComment read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Comment extends EntityMerge<IComment> {}

@registerEntity
export class Comment extends APIEntity<Comment> implements IComment {
  static type: string = 'comment';
  raw_content?: string;
  data?: Record<string, any>;

  constructor(entity: Partial<IComment> = {}) {
    super(entity);
    this.raw_content = entity.raw_content;
    this.data = entity.data ?? {};
  }
}

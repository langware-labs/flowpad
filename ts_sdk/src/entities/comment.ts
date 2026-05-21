import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface IComment extends IEntity {
  raw_content?: string;
  data?: Record<string, any>;
}

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

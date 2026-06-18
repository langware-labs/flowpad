import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface IUserNote extends IEntity {
  content?: string;
}

@registerEntity
export class UserNote extends APIEntity<UserNote> implements IUserNote {
  static type: string = 'user_note';
  content?: string;

  constructor(entity: Partial<IUserNote> = {}) {
    super(entity);
    this.content = entity.content;
  }

  override getDisplayName(): string | null {
    const firstLine = this.content?.trim().split(/\n/)[0]?.slice(0, 100);
    return firstLine || null;
  }
}

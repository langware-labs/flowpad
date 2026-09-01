import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity, EntityMerge } from '../IEntity';

export interface IUserNote extends IEntity {
  content?: string;
}

// `implements IUserNote` only checks the class; it contributes no members, so every
// field declared solely on IUserNote read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface UserNote extends EntityMerge<IUserNote> {}

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

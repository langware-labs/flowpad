import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface ITeam extends IEntity {
  name?: string;
  icon?: string;
}

// `implements ITeam` only checks the class; it contributes no members, so every
// field declared solely on ITeam read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Team extends Omit<ITeam, 'expand' | 'id' | 'is_private' | 'members'> {}

@registerEntity
export class Team extends APIEntity<Team> implements ITeam {
  static type: string = 'team';
  name?: string;
  icon?: string;

  constructor(entity: Partial<ITeam> = {}) {
    super(entity);
    this.name = entity.name;
    this.icon = entity.icon;
  }
}

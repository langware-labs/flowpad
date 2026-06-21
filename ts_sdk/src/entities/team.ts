import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface ITeam extends IEntity {
  name?: string;
  icon?: string;
}

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

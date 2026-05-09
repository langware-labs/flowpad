import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface IAppSecret extends IEntity {
  name: string;
  description?: string;
}

@registerEntity
export class AppSecret extends APIEntity<AppSecret> implements IAppSecret {
  name!: string;
  description?: string;
  static type: string = 'app_secret';

  constructor(entity: Partial<IAppSecret> = {}) {
    super(entity);
    this.name = entity.name ?? '';
    this.description = entity.description;
  }
}

import { defaultEntityType, IEntity } from '../IEntity';

export class EntityFactory {
  private static entityMap: { [type: string]: new (json?: IEntity) => unknown } = {};

  // Registers a new entity type and its constructor
  static registerEntity(constructor: new (json?: IEntity) => unknown) {
    //@ts-ignore
    const type = constructor.type;
    if (!type) {
      throw new Error(`Entity type not defined:${constructor.name}`);
    }
    if (type == defaultEntityType) {
      return;
    }
    if (EntityFactory.entityMap[type] == constructor) return;
    if (EntityFactory.entityMap[type]) {
      throw new Error(`Entity registration conflict:${type}`);
    }
    EntityFactory.entityMap[type] = constructor;
  }
  static getEntityConstructor(type: string): new (json?: IEntity) => unknown {
    return EntityFactory.entityMap[type];
  }

  static createEntity(json: IEntity): any {
    if (json && json.type && EntityFactory.entityMap[json.type]) {
      return new EntityFactory.entityMap[json.type](json);
    }
    console.warn('Unrecognized entity type:', json.type);
    return undefined;
  }
}

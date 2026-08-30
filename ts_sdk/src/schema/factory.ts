import { defaultEntityType, IEntity } from '../IEntity';

/**
 * A registrable entity constructor.
 *
 * Deliberately loose in its parameter: every subclass ctor takes its own
 * `Partial<X>`, and `new (json?: IEntity) => unknown` is not assignable from
 * any of them (parameter positions are checked bivariantly for methods but not
 * for standalone ctor types), which made every `@registerEntity` decorator
 * report "unable to resolve signature".
 */
export type EntityConstructor = new (json?: any) => unknown;

export class EntityFactory {
  private static entityMap: { [type: string]: EntityConstructor } = {};

  // Registers a new entity type and its constructor
  static registerEntity(constructor: EntityConstructor) {
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
  static getEntityConstructor(type: string): EntityConstructor {
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

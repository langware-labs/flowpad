import { APIEntity, registerEntity } from '../APIEntity';

/** A non-human principal the hub signs a machine in as: an agent's own Identity, or one deployment's.
 *  `subject_typeid` is what it acts for (`agent-…` or `deployment-…`). Read through
 *  `dataContext.currentPrincipal`; it is never `currentUser`, which is a person only. */
export interface IIdentity {
  id?: string;
  name?: string;
  title?: string;
  picture?: string;
  subject_typeid?: string;
  status?: string;
}

@registerEntity
export class Identity extends APIEntity<Identity> implements IIdentity {
  name?: string;
  title?: string;
  picture?: string;
  subject_typeid?: string;
  status?: string;
  static type: string = 'identity';

  constructor(entity: Partial<IIdentity> = {}) {
    super(entity as never);
    this.name = entity.name;
    this.title = entity.title;
    this.picture = entity.picture;
    this.subject_typeid = entity.subject_typeid;
    this.status = entity.status;
  }
}

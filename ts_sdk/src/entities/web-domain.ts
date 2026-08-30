import type { EntityMerge } from '../IEntity';
import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { isApiError } from '../ApiResponse';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';

export interface IWebDomain extends IEntity {
  domain: string;
  verified?: boolean;
  micro_app_id: string;
}

// `implements IWebDomain` only checks the class; it contributes no members, so every
// field declared solely on IWebDomain read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WebDomain extends EntityMerge<IWebDomain> {}

@registerEntity
export class WebDomain extends APIEntity<WebDomain> implements IWebDomain {
  static type: string = 'web_domain';
  domain!: string;
  verified?: boolean;
  micro_app_id!: string;

  constructor(entity: Partial<IWebDomain> = {}) {
    super(entity);
    this.domain = entity.domain || '';
    this.verified = entity.verified;
    this.micro_app_id = entity.micro_app_id || '';
  }

  public static async getByName(name: string): Promise<WebDomain | undefined> {
    const actionInfo = new ActionInfo('get-by-name', WebDomain.type);
    actionInfo.queryParameters = { domain: name };
    try {
      return await dataManager.callAction<null, WebDomain>(actionInfo);
    } catch (error) {
      if (isApiError(error) && error.response?.status === 404) {
        console.log(`Web domain not found: ${name}`);
      } else {
        console.error(`Error getting web domain by name: ${name}:`, error);
      }
      return undefined;
    }
  }
}

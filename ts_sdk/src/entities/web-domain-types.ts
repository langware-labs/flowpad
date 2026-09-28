/**
 * The wire shape of a web domain row, separate from the WebDomain class that hydrates it.
 * See the layering rule in `entities/compute-node/compute-node-types.ts`.
 */
import { IEntity } from '../IEntity';

export interface IWebDomain extends IEntity {
  domain: string;
  verified?: boolean;
  /** The endpoint this host name serves. */
  service_endpoint_id?: string | null;
}

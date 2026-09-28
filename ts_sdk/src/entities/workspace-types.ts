/**
 * The wire shape of a workspace row, separate from the Workspace class that hydrates it.
 * See the layering rule in `entities/compute-node/compute-node-types.ts`.
 */
import { IEntity } from '../IEntity';

export interface IWorkspace extends IEntity {
  name?: string;
  namespace?: string;
}

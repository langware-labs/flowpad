/**
 * The wire shape of a visitor row, separate from the Visitor class that hydrates it.
 * See the layering rule in `entities/compute-node/compute-node-types.ts`.
 */
import { IEntity } from '../IEntity';

export interface IVisitor extends IEntity {
  ga_client_id?: string | null;
  utm_params?: Record<string, string> | null;
  visitor_role?: string;
}

/**
 * The wire shape of a label row, separate from the Label class that hydrates it.
 * See the layering rule in `entities/compute-node/compute-node-types.ts`.
 */
import { LabelInfo } from '../models/LabelInfo';

export interface ILabel extends LabelInfo {
  id?: string;
  created_at?: string;
  updated_at?: string;
}

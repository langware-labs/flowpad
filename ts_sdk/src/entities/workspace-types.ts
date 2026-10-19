/**
 * The wire shape of a workspace row, separate from the Workspace class that hydrates it.
 * See the layering rule in `entities/compute-node/compute-node-types.ts`.
 */
import { IEntity } from '../IEntity';

export interface IWorkspace extends IEntity {
  name?: string;
  namespace?: string;
  /** The folder holding this workspace's projects (absolute, canonical). Unset on the
   *  default workspace — its folder is the instance's workspace root. Desktop only. */
  root_path?: string | null;
  /** The folder in the same VFS-relative form as bootstrap `paths.workspace`. */
  root?: string;
  /** True on the default workspace ("Flowpad"), the `@local` row. */
  is_default?: boolean;
}

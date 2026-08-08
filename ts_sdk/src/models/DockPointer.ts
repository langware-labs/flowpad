import { ViewType, PageId } from '../utils/ui/view-types';
import type { TypeId } from './TypeId';
import type { VFSPath } from '../utils/vfs-path';

export interface IDockPointer {
  viewType?: ViewType;
  pointer?: string;
  options?: Record<string, string>;
  /** Which SPA-surface this dock addresses; defaults to `desk` when absent. */
  page?: PageId;
  /**
   * Pure-parse projections the SDK consumes WITHOUT touching the UI DockPointer
   * class (the layering bridge: `Tab.getFromDockPointer` takes this interface).
   * The UI `DockPointer` implements them as getters over the pointer string —
   * no network, no DB.
   */
  /** Tab natural key (== `Tab.pointer`); null when this dock has no tab (home, bare shell). */
  readonly tabHash?: string | null;
  /** The entity this dock targets (`…/typeid/<type>-<id>`, `shell-<id>`, `project-<id>`), or null. */
  readonly targetTypeId?: TypeId | null;
  /** The vfs path an asset-editor dock addresses (`…/vfs/<path>`), or null. */
  readonly vfsPath?: VFSPath | null;
  /** True when this dock IS the app root (`/`). One predicate, owned by the UI
   *  class (`isRootAddress`), so nothing re-derives a weaker version of it. */
  readonly isRoot?: boolean;
}

export class DockPointerData implements IDockPointer {
  constructor(
    public readonly viewType: ViewType,
    public readonly pointer?: string,
    public readonly options?: Record<string, string>,
  ) {}
}

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
  /** Canonical serialization — the string stored as `Tab.pointer`; null when
   *  this dock has no tab. Same bridge as the projections above: implemented by
   *  the UI `DockPointer`, consumed here (see `Tab.getFromDockPointer`). */
  toJSON?(): string | null;
}

export class DockPointerData implements IDockPointer {
  constructor(
    public readonly viewType: ViewType,
    public readonly pointer?: string,
    public readonly options?: Record<string, string>,
  ) {}
}

/**
 * A dock that definitely addresses a target.
 *
 * `DockPointerData.pointer` is optional for good reason — `new
 * DockPointerData(ViewType.INBOX)` and `new DockPointerData(ViewType.SHELL)`
 * are real docks that address a VIEW rather than a row. But some getters
 * provably always build one (from a template literal, or from `typeId`, which
 * throws rather than returning nullish), and their callers should not have to
 * invent a fallback for a case that cannot happen.
 *
 * A subclass rather than an intersection type so the guarantee comes from a
 * required constructor parameter instead of a cast.
 */
export class TargetedDock extends DockPointerData {
  constructor(
    viewType: ViewType,
    public override readonly pointer: string,
    options?: Record<string, string>,
  ) {
    super(viewType, pointer, options);
  }
}

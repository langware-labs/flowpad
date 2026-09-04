import type { IDockPointer } from '../../models/DockPointer';
import { CredentialsSubview, ViewType } from './view-types';

/**
 * Retired view types, mapped to the pointer that replaced them.
 *
 * A view type can be deleted from the UI but not from history: it is baked into
 * saved Tab rows, bookmarks, and links people already sent each other. So it
 * stays decodable and resolves forward here, at the one seam every persisted
 * pointer passes through.
 *
 * This is the ONE statement of the retirement. The URL side
 * (`credentials-dock-canonicalization.ts`, which redirects before anything parses
 * the pointer) derives its matcher from this table rather than restating it —
 * a ViewType's enum value IS its URL segment, so the keys serve both. Retiring
 * the next view is one edit here.
 */
export const RETIRED_DOCK_VIEWS: Partial<Record<ViewType, { viewType: ViewType; pointer: string }>> = {
  [ViewType.ENVIRONMENT]: { viewType: ViewType.CREDENTIALS, pointer: CredentialsSubview.CONNECTIONS },
  [ViewType.CONNECTIONS]: { viewType: ViewType.CREDENTIALS, pointer: CredentialsSubview.CONNECTIONS },
  [ViewType.API_KEYS]: { viewType: ViewType.CREDENTIALS, pointer: CredentialsSubview.CONNECTIONS },
  // Skills folded into the Assets browser; `/dock/skills` otherwise rendered
  // nothing (no registry entry) and fell through to Home.
  [ViewType.SKILLS]: { viewType: ViewType.ASSETS, pointer: 'list/skill' },
};

/**
 * Resolve a retired view type forward. Returns the pointer unchanged when it
 * names a live view, so callers can apply it unconditionally.
 */
export function normalizeRetiredDockPointer(pointer: IDockPointer): IDockPointer {
  const target = pointer.viewType ? RETIRED_DOCK_VIEWS[pointer.viewType] : undefined;
  if (!target) return pointer;

  // The retired trio never carried a pointer of their own, so the subview
  // replaces it outright rather than merging with anything.
  return { ...pointer, viewType: target.viewType, pointer: target.pointer };
}

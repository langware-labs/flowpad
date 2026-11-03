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
 * (`retired-views-dock-canonicalization.ts`, which redirects before anything parses
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
  // The Events screen and its three aliases became Automations. Their selection
  // (`?trigger=`, `?creating=`, `?target=`) rides in OPTIONS, which the URL
  // redirect carries over, so a sent rule link still opens that rule. The old
  // global bus monitor (`signals`) lands on the bus, where its tools now live.
  [ViewType.EVENTS]: { viewType: ViewType.AUTOMATIONS, pointer: '' },
  [ViewType.TRIGGERS]: { viewType: ViewType.AUTOMATIONS, pointer: '' },
  [ViewType.CRON]: { viewType: ViewType.AUTOMATIONS, pointer: '' },
  [ViewType.SIGNALS]: { viewType: ViewType.AUTOMATIONS, pointer: 'bus' },
};

/**
 * Retired SECTIONS of a live view: one (viewType, pointer) that moved to another
 * screen while the rest of its view lives on. Same contract as
 * `RETIRED_DOCK_VIEWS` — decodable forever, resolved forward by
 * `normalizeRetiredDockPointer` — but keyed by view type AND exact pointer, so
 * a sibling pointer of the same view is left alone.
 */
export const RETIRED_DOCK_POINTERS: Partial<
  Record<ViewType, Readonly<Record<string, { viewType: ViewType; pointer: string }>>>
> = {
  // Data sources › Channels became the one Channels screen (`/dock[/hub]/inbound`).
  [ViewType.DATA_SOURCES]: { channels: { viewType: ViewType.INBOUND, pointer: '' } },
};

/** Where a retired view type, or a retired section of a live one, resolves to — or undefined when it is live. */
export function retiredDockTarget(pointer: IDockPointer): { viewType: ViewType; pointer: string } | undefined {
  if (!pointer.viewType) return undefined;
  const view = RETIRED_DOCK_VIEWS[pointer.viewType];
  if (view) return view;
  const sections = RETIRED_DOCK_POINTERS[pointer.viewType];
  const section = pointer.pointer;
  return sections && section != null && Object.hasOwn(sections, section) ? sections[section] : undefined;
}

/**
 * Resolve a retired view type (or retired section) forward. Returns the pointer
 * unchanged when it names a live view, so callers can apply it unconditionally.
 */
export function normalizeRetiredDockPointer(pointer: IDockPointer): IDockPointer {
  const target = retiredDockTarget(pointer);
  if (!target) return pointer;

  // A retired view never carried a pointer of its own and a retired section IS
  // its pointer, so the target replaces it outright rather than merging.
  return { ...pointer, viewType: target.viewType, pointer: target.pointer };
}

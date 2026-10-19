import { FlaskConical, MessageSquare, SquareTerminal, WandSparkles, type LucideIcon } from 'lucide-react';
// Type-only: this table is read by view-mode-context's own importers at module
// load, so a runtime import of the enum would be a load-order cycle. Keys are the
// enum's string values.
import type { ViewMode } from '@src/contexts/view-mode-context';

/**
 * The mode vocabulary every mode control shares — the footer selector and each
 * session's surface switch (`SessionSurfaceSwitch`). One copy, so the two never
 * drift.
 *
 * Labelled by the SURFACE each mode shows, not by its rank — the selector picks
 * vibe / chat pane / terminal, so "Standard"/"Advanced" would describe an internal
 * hierarchy instead of what the user gets. The enum values stay
 * `standard`/`advanced` (persisted preference, URL param).
 */
export const MODE_LABELS: Record<ViewMode, string> = {
  vibe: 'Vibe',
  standard: 'Chat',
  advanced: 'Terminal',
  dev: 'Dev',
};

export const MODE_ICONS: Record<ViewMode, LucideIcon> = {
  vibe: WandSparkles,
  standard: MessageSquare,
  advanced: SquareTerminal,
  dev: FlaskConical,
};

/** Tag word per mode — the observable/highlightable name of each button.
 *  Spelled out rather than derived from the enum so the vocabulary is greppable
 *  (a journey authoring `ViewModeChat` should find this line). */
export const MODE_TAGS: Record<ViewMode, string> = {
  vibe: 'ViewModeVibe',
  standard: 'ViewModeChat',
  advanced: 'ViewModeTerminal',
  dev: 'ViewModeDev',
};

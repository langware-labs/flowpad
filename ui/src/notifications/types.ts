import { ViewType } from '@src/types/ViewType';

/**
 * The single notification data model for the whole UI.
 *
 * One `notify(input)` dispatcher produces these; they are rendered either as a
 * transient toast (no `category`) or a persistent sidebar badge (`category`
 * set). The shape is fully serializable so the same record can come straight
 * off a WS signal — no callbacks, no JSX. See `notify.ts` for the dispatcher.
 */
export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

/** A single call-to-action. Either navigates (`href`) or runs a registered `command`. */
export interface NotificationAction {
  label: string;
  /** In-app route or URL — resolved URL-first by the renderer. */
  href?: string;
  /** Imperative command key, resolved via `commands.ts`. */
  command?: string;
  /** Serializable args handed to the command, e.g. `{ typeId }`. */
  args?: Record<string, string | number | boolean>;
}

export interface NotificationData {
  /** Stable dedupe + dismiss key. A second emit with the same id REPLACES the first. */
  id: string;
  level: NotificationLevel;
  /** Headline — always a plain string. */
  title: string;
  message?: string;
  /** Subject entity (e.g. `skill-<uuid>`); drives the entity icon + default nav. */
  typeId?: string;
  /** Explicit lucide-name glyph override (resolve order: typeId → icon → level). */
  icon?: string;
  /** 0–2 CTAs. */
  actions?: NotificationAction[];
  /** Auto-dismiss after N ms. `null` = sticky. Omitted = per-level default. */
  durationMs?: number | null;
  /** Spinner + no auto-dismiss (loading / in-flight). */
  busy?: boolean;
  /** Present → rendered as a persistent badge under this sidebar view (not a toast). */
  category?: ViewType;
  /** Alerts (`warning`/`error`) only pop as a toast in Dev mode. Set this on the
   *  rare alert that must reach the user in EVERY mode — one that explains why an
   *  action they just took did nothing. It still lands in the warnings log too. */
  forceToast?: boolean;
  /** Stamped on ingest by the dispatcher. */
  timestamp: number;
}

/** The emit shape — the caller never sets `timestamp`. */
export type NotificationInput = Omit<NotificationData, 'timestamp'>;

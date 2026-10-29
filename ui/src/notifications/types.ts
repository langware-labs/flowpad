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
export type NotificationLocation = 'corner' | 'center';

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

/**
 * Everything known about one error, for its details popup and for Diagnose. Any error/warning
 * notification may carry one; `notify` fills it from a thrown `error` when the caller passes one.
 * All fields optional: what a source does not know is simply not shown.
 */
export interface ErrorDetail {
  request?: { method?: string; url?: string; caller?: string };
  response?: { status?: number; message?: string; body?: string; errorCode?: string; requestId?: string };
  /** A spending/usage limit that stopped the work. */
  limit?: { rule?: string; used?: string; cap?: string; endpoint?: string };
  /** When the same failure first and last happened (ms epoch) and how often, as the source counted it. */
  firstAt?: number;
  lastAt?: number;
  count?: number;
  /** The backend log the error was written to. */
  logFile?: string;
  /** Errors that were hidden because too many came at once — each one in full. */
  hidden?: { title: string; detail: ErrorDetail }[];
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
  /** A "Don't ask again" checkbox under the actions; its state rides each action's args as
   *  `remember`. Set by `askNotification` (`ask.ts`). */
  remember?: { label: string };
  /** Auto-dismiss after N ms. `null` = sticky. Omitted = per-level default. */
  durationMs?: number | null;
  /** Spinner + no auto-dismiss (loading / in-flight). */
  busy?: boolean;
  /** Where it shows. `corner` (default): the bottom-right toast. `center`: a blocking dialog in the
   *  middle of the window — no ×, Escape does not close it — for a question the person must answer
   *  before what they asked for can go on. Ignored for a sidebar badge (`category`). */
  location?: NotificationLocation;
  /** Present → rendered as a persistent badge under this sidebar view (not a toast). */
  category?: ViewType;
  /** Alerts (`warning`/`error`) only pop as a toast in Dev mode. Set this on the
   *  rare alert that must reach the user in EVERY mode — one that explains why an
   *  action they just took did nothing. It still lands in the warnings log too. */
  forceToast?: boolean;
  /** Feedback on one click, not a standing condition: toast once in every mode, time out, and
   *  never enter the warnings log. An unopenable link is the case — logging it left a permanent
   *  warning for a click the user already saw fail. */
  transient?: boolean;
  /** What a Details popup shows for an error/warning (see `ErrorDetail`). */
  detail?: ErrorDetail;
  /** Stamped by the dispatcher: when an alert under this id was first emitted, and how many times. */
  firstAt?: number;
  count?: number;
  /** Stamped on ingest by the dispatcher. */
  timestamp: number;
}

/** The emit shape — the caller never sets `timestamp`. */
/**
 * What a caller passes to `notify`. `id` is optional here even though it is
 * required on `NotificationData`: the dispatcher derives it when omitted
 * (`input.id ?? \`${level}:${djb2(title)}\``), which is what makes dedupe by
 * title work. Omitting only `timestamp` made `id` mandatory on every call site
 * and put 402 errors on the board.
 */
export type NotificationInput = Omit<NotificationData, 'timestamp' | 'id' | 'firstAt' | 'count'> & {
  id?: string;
  /** The thrown error behind an error/warning — `notify` turns it into `detail` (it is not kept). */
  error?: unknown;
};

/**
 * The text a copy affordance yields for a notification: the title, and the
 * message under it when there is one.
 *
 * One definition because two surfaces show the same alert — the toast and the
 * footer warnings popover — and a person who copies from one and pastes from the
 * other must get the same thing. The popover composed this inline first; the
 * toast now shares it rather than spelling the join a second time.
 */
export function notificationText(data: Pick<NotificationData, 'title' | 'message'>): string {
  return data.message ? `${data.title}\n${data.message}` : data.title;
}

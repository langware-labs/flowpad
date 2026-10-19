import type { IDockPointer } from '../../models/DockPointer';

/**
 * What a guided step waits for.
 *
 * A step lists CONDITIONS, in order. Each is satisfied before the next is
 * checked, so a step can say "wait for the click, THEN wait for the app to
 * actually be somewhere else" — which is the difference between a journey that
 * describes what happened and one that narrates ahead of it.
 *
 * The author says what must be true. HOW each kind is observed — a bus
 * subscription, a DOM observer, the router — is the runtime's business and
 * appears nowhere in a journey document.
 *
 * Two natures of condition, and the distinction is load-bearing:
 *
 *  - **occurrence** (`click`, `event`) — something HAPPENED while the
 *    condition was being waited on. Cannot already be true when the step
 *    reaches it, and proves only that the user (or an agent) acted — never that
 *    the app responded.
 *  - **state** (`element`, `location`, `entity`) — the world IS a certain way.
 *    Can already be true the moment the step reaches it, which is what lets a
 *    reload mid-journey pick up where it left off, and what lets a setup step
 *    pass instantly when the thing was already set up.
 *
 * A step that claims a consequence should end on a STATE condition. Ending on
 * an occurrence only proves someone clicked.
 *
 * NO TIMEOUTS, deliberately: a condition waits indefinitely, and the tray's
 * Continue/Skip is the escape hatch. A time budget here would be a way for a
 * step to pass while the app is still wrong.
 */

/** A tagged element must be on screen, or must have left it. */
export interface JourneyElementMatch {
  /** `data-tag` word that must be present. */
  present?: string;
  /** `data-tag` word that must NOT be present. */
  gone?: string;
}

/** Where the app must be. Every field given must match. */
export interface JourneyLocationMatch {
  viewType?: string;
  pointer?: string;
  page?: string;
  /** The app root (`/`) — the desk home with no pointer. */
  root?: boolean;
  /** URL options that must hold. A `null` value asserts the option is ABSENT. */
  options?: Record<string, string | null>;
}

/** Rows that must exist in the store. */
export interface JourneyEntityMatch {
  /** Entity type, e.g. `capability`, `agentic_process`. */
  type: string;
  /** `QueryFilter` match expression. */
  match?: Record<string, unknown>;
  /** How many must match. Default 1. */
  min?: number;
  /** `project` (default) scopes to the active project; `all` does not. */
  scope?: 'project' | 'all';
  /** Match CLIENT-side over fetched rows instead of in the server query — for
   *  serialization-derived fields the DB cannot see (e.g. `is_turn_busy`). */
  local?: boolean;
}

export type JourneyWaitCondition =
  /** A click on a `data-tag`-tagged element. Occurrence. */
  | { click: string }
  /**
   * A raw bus tag — the escape hatch for things that leave no observable state
   * of their own: an agent's `flow show`, a signal postMessaged from a sandboxed
   * page, a journey act announcing itself. Occurrence.
   */
  | { event: { tag: string; target?: string } }
  /**
   * A tagged element is on screen, or has left it. State.
   *
   * The escape hatch of the state conditions: reach for `location` or `entity`
   * first, which say what is TRUE rather than what is RENDERED. Use this when
   * the fact has no other expression — "the workspace pane is gone" is one.
   */
  | { element: JourneyElementMatch }
  /** The app is at a location. State. */
  | { location: JourneyLocationMatch }
  /** The store holds matching rows. State. */
  | { entity: JourneyEntityMatch }
  /** Only the tray's Continue moves on — for a step the user should read. */
  | { manual: true }
  /** Any ONE of these. */
  | { any: JourneyWaitCondition[] }
  /** ALL of these at once. */
  | { all: JourneyWaitCondition[] };

/** A step's conditions, in order. */
export type JourneyWaitFor = JourneyWaitCondition[];

/** Condition kinds. Twin of `GUIDED_WAIT_KINDS` in the Python validator. */
export const GUIDED_WAIT_KINDS: ReadonlySet<string> = new Set([
  'click',
  'event',
  'element',
  'location',
  'entity',
  'manual',
  'any',
  'all',
]);

/** The kind word of a condition — the single key it is expressed with. */
export function waitKind(condition: JourneyWaitCondition): string {
  return Object.keys(condition)[0] ?? '';
}

/** Does `loc` satisfy `match`? Pure — no DOM, no store. */
export function matchesLocation(loc: IDockPointer | null, match: JourneyLocationMatch): boolean {
  if (!loc) return false;
  // `isRoot` comes off the pointer rather than being re-derived here: the real
  // predicate also requires the desk page and the dock layout, so an inline
  // `viewType === HOME && !pointer` would call the HUB home (and a `/win/home`
  // focus window) the root.
  if (match.root !== undefined && match.root !== !!loc.isRoot) return false;
  if (match.viewType !== undefined && loc.viewType !== match.viewType) return false;
  if (match.pointer !== undefined && (loc.pointer ?? '') !== match.pointer) return false;
  if (match.page !== undefined && loc.page !== match.page) return false;
  for (const [key, want] of Object.entries(match.options ?? {})) {
    const have = loc.options?.[key] ?? null;
    if (want === null ? have !== null : have !== want) return false;
  }
  return true;
}

/** Does the live document satisfy `match`? The only DOM-reading helper here. */
export function matchesElement(match: JourneyElementMatch, doc: Document): boolean {
  const found = (tag: string) => !!doc.querySelector(`[data-tag="${cssEscape(tag)}"]`);
  if (match.present !== undefined && !found(match.present)) return false;
  if (match.gone !== undefined && found(match.gone)) return false;
  return true;
}

/** `CSS.escape` is absent in some DOM environments (jsdom) — same fallback the
 *  highlight observer uses, kept here so both agree on the selector. */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}

/** Authoring problems in a condition tree, as human-readable lines. */
export function waitConditionProblems(condition: JourneyWaitCondition, where: string): string[] {
  const kind = waitKind(condition);
  if (!GUIDED_WAIT_KINDS.has(kind)) return [`${where}: unknown waitFor condition "${kind}"`];
  if ('any' in condition || 'all' in condition) {
    const branches = 'any' in condition ? condition.any : condition.all;
    if (!branches.length) return [`${where}: "${kind}" needs at least one condition`];
    return branches.flatMap((c) => waitConditionProblems(c, where));
  }
  if ('event' in condition && !condition.event.tag) return [`${where}: event condition needs a tag`];
  if ('click' in condition && !condition.click) return [`${where}: click condition needs a tag word`];
  if ('entity' in condition && !condition.entity.type) return [`${where}: entity condition needs a type`];
  if ('element' in condition && condition.element.present === undefined && condition.element.gone === undefined) {
    return [`${where}: element condition needs "present" or "gone"`];
  }
  return [];
}

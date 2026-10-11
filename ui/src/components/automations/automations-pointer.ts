/**
 * The Automations dock's address: three places, one tab.
 *
 *   /dock/automations                         the list (simple first)
 *   /dock/automations?trigger=<id>            one automation's page (Setup)
 *   /dock/automations?trigger=<id>&tab=runs   …its Runs tab
 *   /dock/automations?creating=<kind>[&recipe=<id>]
 *                                             a new automation of that kind
 *   /dock/automations?creating=message[&source=<data_source id>&message=<flow_message id>]
 *                                             a new rule on messages arriving, prefilled from one
 *   /dock/automations/runs[?run=<id>&status=failed&trigger=<id>]
 *                                             every run; one open on the right
 *   /dock/automations/bus[?tag=<tag>&target=<type:id>]
 *                                             the event bus (Advanced)
 *
 * The PLACE rides the pointer (so the address bar reads `Automations › Runs`);
 * what is selected rides options. `foldsPointer` keeps every level in one chip.
 * No React here: the view, the navigator and DockPointer all share it.
 */
import type { AutomationKind, RunStatus } from '@sdk';

export type AutomationsPlace = 'list' | 'runs' | 'bus';
export type AutomationTab = 'setup' | 'runs';
/** What a new automation is made of: one of the four kinds, or a rule on messages arriving
 *  (an `event` rule underneath, with its own screen). */
export type CreatingKind = AutomationKind | 'message';

export interface AutomationsRoute {
  place: AutomationsPlace;
  /** An open automation (list place) or the automation the runs are filtered to. */
  trigger?: string | null;
  /** A new automation being made, by kind. */
  creating?: CreatingKind | null;
  /** A message rule's prefill: the channel (data source id) and the message it was started from. */
  source?: string | null;
  message?: string | null;
  /** A starter the new automation is prefilled from (`automation-recipes.ts`). */
  recipe?: string | null;
  tab?: AutomationTab | null;
  /** The run open in the Runs place. */
  run?: string | null;
  status?: RunStatus | null;
  /** The event type the bus is focused on. */
  tag?: string | null;
  /** Narrow the bus to one subject (`data_source:<id>`). */
  target?: string | null;
}

const PLACES: readonly AutomationsPlace[] = ['list', 'runs', 'bus'];
const KINDS: readonly CreatingKind[] = ['schedule', 'event', 'file', 'agent_hook', 'message'];
const STATUSES: readonly RunStatus[] = ['running', 'launched', 'succeeded', 'failed', 'skipped'];

export function automationsPointer(place: AutomationsPlace = 'list'): string | undefined {
  return place === 'list' ? undefined : place;
}

/** The options a route carries, in a stable key order. */
export function automationsOptions(route: AutomationsRoute): Record<string, string> {
  const out: Record<string, string> = {};
  if (route.trigger) out.trigger = route.trigger;
  if (route.creating) out.creating = route.creating;
  if (route.recipe) out.recipe = route.recipe;
  if (route.source) out.source = route.source;
  if (route.message) out.message = route.message;
  if (route.tab && route.tab !== 'setup') out.tab = route.tab;
  if (route.run) out.run = route.run;
  if (route.status) out.status = route.status;
  if (route.tag) out.tag = route.tag;
  if (route.target) out.target = route.target;
  return out;
}

function oneOf<T extends string>(value: string | undefined | null, allowed: readonly T[]): T | null {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * Read a dock's pointer + options as a route. Unknown values fall back to the
 * list — an old or hand-typed link lands somewhere useful, never on a blank pane.
 * `creating=schedule` from the old Events screen keeps working.
 */
export function parseAutomationsRoute(
  pointer?: string | null,
  options?: Record<string, string> | null,
): AutomationsRoute {
  const head = (pointer ?? '').split('/').filter(Boolean)[0];
  const place = oneOf(head, PLACES) ?? 'list';
  const o = options ?? {};
  return {
    place,
    trigger: o.trigger || null,
    creating: oneOf(o.creating, KINDS),
    recipe: o.recipe || null,
    source: o.source || null,
    message: o.message || null,
    tab: o.tab === 'runs' ? 'runs' : null,
    run: o.run || null,
    status: oneOf(o.status, STATUSES),
    tag: o.tag || null,
    target: o.target || null,
  };
}

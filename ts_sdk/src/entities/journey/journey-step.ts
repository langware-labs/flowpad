/**
 * The guided-step vocabulary — the authoring surface of a journey's `graph.json`.
 *
 * These types used to live in a React hook module (`ui/src/journey/use-journey.ts`),
 * which made the journey's whole domain model unreachable from anything but a
 * mounted component. They are plain data: no React, no DOM, no network.
 *
 * Python twin: `flow_sdk/graph_workflow_manager/graph_workflow_doc.py`. The two
 * sides agree on `node_type === "guided_step"` and on the vocabulary constants
 * below; the backend validates them and passes `status_line`/`present`/`waitFor`
 * through as opaque data. The FIELD-LEVEL meaning of `present.highlight`, every
 * act variant, and every wait condition lives here and only here.
 */

import type { JourneyWaitFor } from './journey-wait';

/** Where a step points the user — a standard dock pointer descriptor.
 *  `root` = the app home `/` (not a dock URL) — the typical journey start. */
export interface JourneyPresentDock {
  /**
   * `stay` = this step is about the surface the PREVIOUS step's act produced —
   * a build the journey just opened, whose id cannot be authored. It keeps the
   * current dock and only stamps the step number on it.
   *
   * The one path-dependent kind, and deliberately spelled out: steps used to be
   * path-dependent by DEFAULT (an absent dock meant "wherever they are"), which
   * is why the same step could render two ways. Saying it makes it reviewable —
   * a `stay` that is not preceded by a step that navigates is an authoring bug
   * you can see in the document.
   */
  kind?: 'asset_editor' | 'home' | 'wiki' | 'asset_list' | 'root' | 'stay';
  vfs?: string;
  name?: string;
  /**
   * The view mode to present in. Defaults to `vibe` — a journey runs in the
   * simplest skin and does not drop out of it.
   *
   * Authorable because that default is a policy, not a fact, and it was applied
   * to every step unconditionally: a journey whose SUBJECT is the vibe boundary
   * had its opening state written for it, so "Start in Vibe" was already true
   * before the user did anything and the entrance could never be demonstrated.
   * A journey about leaving vibe has to be able to start outside it.
   */
  viewMode?: 'vibe' | 'standard' | 'advanced' | 'dev';
}

/** What a guided step can do FOR the user. Twin of `GUIDED_ACT_KINDS`. */
export type JourneyActKind =
  | 'click'
  | 'fill'
  | 'open_terminal'
  | 'run'
  | 'fs_check'
  | 'setup_capability'
  | 'oauth_connect'
  | 'device_login'
  | 'git_check';

/**
 * Something the journey does FOR the user, offered as a highlighted button on
 * the step (`fill` → "Fill text") rather than performed behind their back. It
 * aims at the same `data-tag` anchor `present.highlight` uses, and announces
 * itself on the bus (`app.journey.act.done`) so the step's `await` gates on it
 * like any other event.
 */
export interface JourneyActSpec {
  /**
   * `click` presses the `data-tag` surface the step already highlights — the
   * third of the tag's three powers (highlight, observe, act). Without it a
   * step could point at a control and wait for it, but never demonstrate it:
   * pressing Next narrated "this is your workspace" over a screen where nothing
   * had been opened. The step's `waitFor` still gates on the real consequence,
   * so the act moves the app and the condition proves it arrived.
   * `fill` types text into a `data-tag` surface. The setup kinds drive the
   * capability system through its existing verbs: `setup_capability` fires the
   * install agentic process, `oauth_connect` opens the provider's OAuth flow,
   * `device_login` starts the capability's device-login session (surfaced by
   * the harness login modal). Their completion is NOT the act — the step's
   * `await` gates on the capability row reaching the wanted state.
   * `git_check` verifies the project's working tree against real git state
   * (via the compute node's `git-ops` action) — the "Check" button of a
   * try-it-yourself step: done only when the repo actually satisfies `expect`.
   */
  kind: JourneyActKind;
  /** Tag word of the target surface — `[data-tag="…"]`. For `git_check`
   *  it is just the act's bus identity (`git_check:<target>`), no DOM anchor. */
  target: string;
  text?: string;
  /** Capability kind for `setup_capability` / `device_login`. */
  capability?: string;
  /** OAuth provider for `oauth_connect` (default "github"). */
  provider?: string;
  /** `run`: the shell command to type + Enter into the step's terminal. */
  command?: string;
  /** `fs_check`: project-relative file that must exist. */
  path?: string;
  /** The assertion: for `fs_check` the file must contain it; for `run` the
   *  command's OUTPUT must contain it (and the command must exit 0) — without
   *  it, `run` only proves the keystrokes reached the terminal. */
  contains?: string;
  /** `git_check`: the repo predicate that must hold. */
  expect?: 'repo' | 'staged' | 'clean' | 'branch' | 'dirty';
  /** `git_check` + `expect:"branch"`: the branch name that must be current. */
  branch?: string;
  /** `git_check`: subfolder of the project working tree holding the repo. */
  dir?: string;
}

/** One guided step, as authored in a journey's `graph.json`. */
export interface JourneyStep {
  node_id: string;
  name: string;
  status_line: string;
  /**
   * A GATE, not a driver: what must be true before Next can land on the next
   * step. Optional — most steps have nothing to wait for.
   *
   * It never advances anything on its own. The user presses Next; if a gate is
   * outstanding the press waits for it and then completes. Conditions used to
   * DRIVE navigation, which meant two things moved the journey (the user, and
   * the app satisfying a condition) — every flake came from that collision.
   * See `journey-wait.ts`.
   */
  waitFor?: JourneyWaitFor;
  /** Sub-step grouping: consecutive steps sharing a `group` render under one
   *  expandable header in the tray/viewer. Pure presentation — the journal's
   *  cursor/entries machinery is flat and unchanged. */
  group?: string;
  /**
   * The step's destination — REQUIRED, and complete.
   *
   * Loading a step is a plain navigation to this dock; nothing is merged onto
   * where the user already was. A partial `present` used to be composed onto the
   * live location, so a step's appearance depended on the path taken to reach
   * it. A step that talks about the previous screen repeats its dock: saying it
   * twice is what makes both steps addressable on their own.
   */
  present: { dock: JourneyPresentDock; highlight?: string };
  act?: JourneyActSpec;
}

/** A render section: ungrouped steps stand alone; grouped ones share a header. */
export interface JourneyStepGroup {
  group: string | null;
  /** Indices into the flat `steps` array (order preserved). */
  indices: number[];
}

// ── the vocabulary constants, twinned with the Python validator ──
// `graph_workflow_doc.py:57,62-63`. Kept as plain sets here (not derived from
// the unions above) because a TS type erases at runtime and `problems()` needs
// to check authored JSON, which is `unknown` by definition.

/** Legal `present.dock.kind` values. */
export const GUIDED_PRESENT_KINDS: ReadonlySet<string> = new Set([
  'asset_editor',
  'wiki',
  'home',
  'asset_list',
  'root',
  'stay',
]);

/** Legal `act.kind` values. */
export const GUIDED_ACT_KINDS: ReadonlySet<string> = new Set<JourneyActKind>([
  'click',
  'fill',
  'open_terminal',
  'run',
  'fs_check',
  'setup_capability',
  'oauth_connect',
  'device_login',
  'git_check',
]);

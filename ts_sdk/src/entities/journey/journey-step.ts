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
  kind?: 'asset_editor' | 'home' | 'wiki' | 'asset_list' | 'root';
  vfs?: string;
  name?: string;
}

/** What a guided step can do FOR the user. Twin of `GUIDED_ACT_KINDS`. */
export type JourneyActKind =
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
  /** What must be true before the step completes — see `journey-wait.ts`. */
  waitFor: JourneyWaitFor;
  /** Sub-step grouping: consecutive steps sharing a `group` render under one
   *  expandable header in the tray/viewer. Pure presentation — the journal's
   *  cursor/entries machinery is flat and unchanged. */
  group?: string;
  present: { dock?: JourneyPresentDock; highlight?: string };
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
]);

/** Legal `act.kind` values. */
export const GUIDED_ACT_KINDS: ReadonlySet<string> = new Set<JourneyActKind>([
  'fill',
  'open_terminal',
  'run',
  'fs_check',
  'setup_capability',
  'oauth_connect',
  'device_login',
  'git_check',
]);

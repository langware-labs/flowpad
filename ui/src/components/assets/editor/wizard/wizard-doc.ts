/**
 * The `wizard.json` document, as the editor manipulates it. Pure — no React, no
 * SDK calls — so the parts that are easy to get catastrophically wrong (losing a
 * key, producing a step with two actions) are testable in milliseconds.
 *
 * Mirrors `WizardSpec` (flow_sdk/schema/data_spec/wizard_spec.py). The backend
 * is the validator: `extra="forbid"` there means every key IS known to the
 * schema, so the risk this module guards is different — keys unknown to the
 * FORM. The document is nested (triggers, per-OS command maps, `input.shape`,
 * three separate timeouts), and an McpForm-style shallow spread of one step
 * would silently delete its siblings.
 */
import type { WizardIssue } from '@sdk';

export type WizardCommandMap = Record<string, string>;

export interface WizardCheckDoc {
  commands?: WizardCommandMap;
  satisfied_codes?: number[];
  timeout_seconds?: number;
}

/** An agentic step's action — it hands the work to an agent.
 *
 *  `output` is what makes the agent's answer READABLE: declare a name and the
 *  runner adds a result contract to the prompt, reads what the agent wrote, and
 *  fails the step if the agent says it failed. Leave it empty and the step is
 *  what it always was — "the agent stopped". */
export interface WizardProcessDoc {
  agent?: string;
  prompt?: string;
  name?: string;
  timeout_seconds?: number;
  output?: string;
  shape?: unknown;
}

/** What invokes a wizard without a person clicking Run. */
export interface WizardTriggerDoc {
  on: string;
  /** At most once per machine, ever — the Trigger row's counter is the record. */
  fire_once?: boolean;
  /** Only fire for events about this target (`type:id`, trailing `*` allowed). */
  target?: string;
}

export interface WizardStepDoc {
  id: string;
  label?: string;
  description?: string;
  precondition?: WizardCheckDoc;
  command?: { commands?: WizardCommandMap; timeout_seconds?: number };
  process?: WizardProcessDoc;
  input?: { name: string; shape?: unknown; label?: string; description?: string };
  verify?: WizardCheckDoc;
  on_fail?: string;
}

export interface WizardDoc {
  name?: string;
  description?: string;
  enabled?: boolean;
  version?: string;
  agent?: string;
  steps?: WizardStepDoc[];
  triggers?: WizardTriggerDoc[];
  [key: string]: unknown;
}

/** The three ways a step can act. Exactly one is present — the backend's
 *  `_exactly_one_action` refuses a document with none or two. */
export const ACTION_KINDS = ['command', 'process', 'input'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** The platforms a command map may key on, in the order the form shows them. */
export const PLATFORMS = ['darwin', 'linux', 'win32'] as const;

/** Which action a step currently carries, or `undefined` for a malformed one. */
export function actionKindOf(step: WizardStepDoc): ActionKind | undefined {
  return ACTION_KINDS.find((kind) => step[kind] != null);
}

/**
 * Set `path` to `value`, copying only the spine — every sibling key at every
 * level is preserved by reference.
 *
 * This is the whole reason the form can be trusted with a nested document. A
 * numeric segment addresses an array index; a string segment an object key.
 */
export function setIn<T>(root: T, path: (string | number)[], value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  if (typeof head === 'number') {
    const list = Array.isArray(root) ? [...(root as unknown[])] : [];
    list[head] = setIn(list[head], rest, value);
    return list as unknown as T;
  }
  const obj = { ...((root ?? {}) as Record<string, unknown>) };
  obj[head] = setIn(obj[head], rest, value);
  return obj as T;
}

/**
 * Remove the key (or array element) at `path`, preserving every sibling.
 *
 * Needed as its own verb because writing `undefined` is not deletion:
 * `JSON.stringify` drops an undefined VALUE but keeps an array HOLE as `null`,
 * and `null` fails the backend's optional-field validation with an error that
 * points at a field the person never touched.
 */
export function removeIn<T>(root: T, path: (string | number)[]): T {
  if (path.length === 0) return undefined as unknown as T;
  const [head, ...rest] = path;
  if (typeof head === 'number') {
    if (!Array.isArray(root)) return root;
    const list = [...(root as unknown[])];
    if (rest.length === 0) list.splice(head, 1);
    else list[head] = removeIn(list[head], rest);
    return list as unknown as T;
  }
  if (root == null || typeof root !== 'object') return root;
  const obj = { ...(root as Record<string, unknown>) };
  if (rest.length === 0) delete obj[head];
  else obj[head] = removeIn(obj[head], rest);
  return obj as T;
}

/**
 * Switch a step to a different kind of action, ATOMICALLY.
 *
 * The old action is removed and the new one seeded in ONE transition, so the
 * document never passes through a state that violates `_exactly_one_action`.
 * Doing it as two edits — remove, then add — would make every intermediate
 * document invalid, and with validate-on-blur that means an error banner on a
 * change the person has not finished making. This is what makes the switch
 * livable rather than infuriating.
 */
export function setStepAction(doc: WizardDoc, index: number, kind: ActionKind): WizardDoc {
  const step = doc.steps?.[index];
  if (!step) return doc;
  const next: WizardStepDoc = { ...step };
  for (const existing of ACTION_KINDS) delete next[existing];
  if (kind === 'command') next.command = { commands: {} };
  // Seeded with the fields the form edits, so a freshly switched step renders
  // its inputs instead of an empty panel.
  else if (kind === 'process') next.process = { agent: '', prompt: '' };
  else next.input = { name: '', shape: 'string' };
  return setIn(doc, ['steps', index], next);
}

/** A blank step, seeded with the commonest action so it is valid on arrival. */
export function blankStep(existing: WizardStepDoc[]): WizardStepDoc {
  const taken = new Set(existing.map((step) => step.id));
  let n = existing.length + 1;
  while (taken.has(`step-${n}`)) n += 1;
  return { id: `step-${n}`, command: { commands: {} } };
}

/**
 * Backend issues, indexed by the field they address.
 *
 * The key is the `loc` joined with `.` — `steps.0.command.commands` — so a field
 * can look up its own problems without every field scanning the whole list.
 */
export function issuesByLoc(issues: WizardIssue[] | undefined): Map<string, WizardIssue[]> {
  const map = new Map<string, WizardIssue[]>();
  for (const issue of issues ?? []) {
    const key = (issue.loc ?? []).join('.');
    const at = map.get(key);
    if (at) at.push(issue);
    else map.set(key, [issue]);
  }
  return map;
}

/** Issues that belong to no field the form renders — shown at the top, never
 *  dropped: an error nothing displays is worse than a clumsy one. */
export function orphanIssues(
  issues: WizardIssue[] | undefined,
  rendered: Set<string>,
): WizardIssue[] {
  return (issues ?? []).filter((issue) => !rendered.has((issue.loc ?? []).join('.')));
}

/**
 * Activity state → how the two run surfaces name it.
 *
 * ONE table, because the step list (which draws an outcome icon) and the
 * debugger (which prints a word) were reading the same seven activity states
 * through two separate literals in two files — so adding or renaming a state
 * meant editing both, and nothing failed if you edited one.
 */
export const LIVE_STATE: Record<string, { status: string; label: string }> = {
  pending: { status: 'not_reached', label: 'waiting' },
  running: { status: 'awaiting_input', label: 'running' },
  blocked: { status: 'awaiting_input', label: 'needs an answer' },
  completed: { status: 'completed', label: 'done' },
  failed: { status: 'failed', label: 'failed' },
  cancelled: { status: 'not_reached', label: 'cancelled' },
  interrupted: { status: 'failed', label: 'stopped' },
};

/**
 * The uname the backend's reconciler mints for a wizard's Nth declared trigger.
 *
 * A mirror of `_wizard_slug` in `flow_sdk/server/builtin_triggers.py`: the
 * wizard's FOLDER name, lowercased, every non-alphanumeric character replaced
 * by `_`. It is the only join between a trigger a document declares and the row
 * that records whether it has fired, so the two spellings have to agree —
 * deriving it from the display name instead silently matched nothing.
 */
export function wizardTriggerUname(assetRef: string, index: number): string {
  const folder = (assetRef.split('/').filter(Boolean).pop() ?? 'wizard').toLowerCase();
  const slug = folder.replace(/[^a-z0-9]/g, '_').replace(/^_+|_+$/g, '') || 'wizard';
  return `wizard_${slug}_${index}`;
}

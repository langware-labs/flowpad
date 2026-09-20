/**
 * The `wizard.json` document, as the editor manipulates it. Pure — no React, no
 * SDK calls — so the parts that are easy to get catastrophically wrong (losing a
 * key, producing a step the backend refuses) are testable in milliseconds.
 *
 * Mirrors `WizardSpec` (flow_sdk/schema/data_spec/wizard_spec.py). The backend
 * is the validator: `extra="forbid"` there means every key IS known to the
 * schema, so the risk this module guards is different — keys unknown to the
 * FORM. A step is now flat (`kind` / `ref` / `args`), but the document around it
 * still nests (`inputs`, `args`, `output`), and a shallow spread of one step or
 * one input would silently delete its siblings.
 */
import type { WizardIssue } from '@sdk';

/** What a step invokes. `ref` is read against this: an op name, a wizard name,
 *  or — for `ask` — one of this wizard's own `inputs` keys. */
export const STEP_KINDS = ['compute', 'wizard', 'ask'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** What a step does when it fails. */
export const ON_FAIL = ['abort', 'continue'] as const;

/** One declared PARAMETER of the wizard. The map key is its name — the same
 *  name an `ask` step refs and an `args` value may pass along. */
export interface WizardInputDoc {
  /** Authoring form: `"string"`, `{field: shape}`, or `[shape]`. */
  shape?: unknown;
  label?: string;
  description?: string;
  optional?: boolean;
}

export interface WizardStepDoc {
  id: string;
  label?: string;
  description?: string;
  kind?: StepKind;
  /** An op name · a wizard name · an input name, per `kind`. */
  ref?: string;
  /** Callee param -> a name in scope, or a literal. A FLAT string map: this is
   *  not a template language, so there is nothing nested to render. */
  args?: Record<string, string>;
  on_fail?: string;
}

export interface WizardDoc {
  name?: string;
  description?: string;
  enabled?: boolean;
  version?: number;
  icon?: string;
  /** Non-empty ⇒ a CONVERSATIONAL wizard: one agent, no steps. */
  agent?: string;
  /** The wizard's parameters, declared once for the whole document. */
  inputs?: Record<string, WizardInputDoc>;
  /** What the wizard returns, in authoring form. */
  output?: unknown;
  steps?: WizardStepDoc[];
  [key: string]: unknown;
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
 * Switch a step to a different `kind`, ATOMICALLY.
 *
 * `ref` is cleared with it, because its MEANING changed: the same string reads
 * as an op name under `compute` and as an input name under `ask`, so carrying it
 * across would leave a step pointing at something that does not exist while
 * looking deliberate. `args` goes the same way — an `ask` step passes none.
 */
export function setStepKind(doc: WizardDoc, index: number, kind: StepKind): WizardDoc {
  const step = doc.steps?.[index];
  if (!step) return doc;
  const next: WizardStepDoc = { ...step, kind, ref: '' };
  if (kind === 'ask') delete next.args;
  else next.args = {};
  return setIn(doc, ['steps', index], next);
}

/**
 * The first `${prefix}${n}` nobody has taken.
 *
 * One home for what was three copies — steps, parameters and a step's args all
 * mint a name this way, and the copies had already drifted on where `n` starts.
 */
export function nextFreeName(taken: Iterable<string>, prefix: string): string {
  const used = new Set(taken);
  let n = used.size + 1;
  while (used.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

/** A blank step, seeded with the commonest kind so it is valid on arrival. */
export function blankStep(existing: WizardStepDoc[]): WizardStepDoc {
  const id = nextFreeName(existing.map((step) => step.id), 'step-');
  return { id, kind: 'compute', ref: '', args: {} };
}

/** A name for a new parameter that does not collide with a declared one. */
export function blankInputName(inputs: Record<string, WizardInputDoc> | undefined): string {
  return nextFreeName(Object.keys(inputs ?? {}), 'INPUT_');
}

/**
 * Rename one `inputs` key IN PLACE in the map's order.
 *
 * Delete-then-add would move the parameter to the end of the form on every
 * rename, which reads as the row jumping away from the caret. Order is also the
 * order the run asks for values, so it is not merely cosmetic.
 */
export function renameInput(doc: WizardDoc, from: string, to: string): WizardDoc {
  const inputs = doc.inputs;
  if (!inputs || !(from in inputs) || to === from || !to || to in inputs) return doc;
  const next: Record<string, WizardInputDoc> = {};
  for (const [key, value] of Object.entries(inputs)) next[key === from ? to : key] = value;
  return setIn(doc, ['inputs'], next);
}

/**
 * Step ids declared more than once.
 *
 * A step id is an activity address segment and the key a run outcome joins on,
 * so two steps sharing one collapse onto a single node and one silently
 * overwrites the other's result. Answered here rather than waited on from the
 * backend because it costs nothing and the form can point at the offending row.
 */
export function duplicateStepIds(steps: WizardStepDoc[] | undefined): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const step of steps ?? []) {
    if (seen.has(step.id)) twice.add(step.id);
    else seen.add(step.id);
  }
  return twice;
}

/**
 * The names an `args` value may refer to, in the order they come into scope:
 * the wizard's own parameters, then every step BEFORE this one.
 *
 * Offered, never enforced — a value is a name in scope or a literal, and the
 * form cannot tell which was meant.
 */
export function namesInScope(doc: WizardDoc, index: number): string[] {
  const steps = doc.steps ?? [];
  return [...Object.keys(doc.inputs ?? {}), ...steps.slice(0, index).map((step) => step.id)].filter(
    Boolean,
  );
}

/**
 * An authoring-form shape, as one editable line, and back.
 *
 * `"string"` is the overwhelmingly common case and must stay typeable as three
 * plain words; anything structured is JSON. Unparseable text is kept as a
 * STRING rather than rejected — the backend is the validator, and refusing to
 * record what someone typed loses it.
 */
export function shapeToText(shape: unknown): string {
  if (shape == null) return '';
  if (typeof shape === 'string') return shape;
  return JSON.stringify(shape);
}

export function shapeFromText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/**
 * Backend issues, indexed by the field they address.
 *
 * The key is the `loc` joined with `.` — `steps.0.args` — so a field can look up
 * its own problems without every field scanning the whole list.
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

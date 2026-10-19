/**
 * Credential — a named set of environment variables, and the only way to
 * declare secrets (flow_sdk/builtin/credential.py).
 *
 * Where the folder lives is its scope: a project (`<project>/agentic-assets/
 * credential/<name>/`), the user (`~/agentic-assets/credential/<name>/`), or the
 * shipped catalogue (`system` — a template, added to one of the other two).
 * Where its values live is a deployment's, never the credential's (this computer
 * keeps them in the scope's `.env.local` unless told otherwise). Declaring,
 * filling and removing go through `credentialsService`.
 */
import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity, EntityMerge } from '../IEntity';

/**
 * How much a project needs one variable (`flow_sdk` `CredentialRequirement`).
 * `MUST`: the app does not work without it. `OPTIONAL`: it turns a feature, an
 * integration or a deployment on. `ONE_OF`: every `ONE_OF` variable of one
 * credential forms an either-or group, and one member is enough.
 */
export const CredentialRequirement = { MUST: 'MUST', OPTIONAL: 'OPTIONAL', ONE_OF: 'ONE_OF' } as const;
export type CredentialRequirement = (typeof CredentialRequirement)[keyof typeof CredentialRequirement];

/** What a variable's value IS: the value (`text`), a file's content kept as a file (`file`) — the
 *  variable then holds the file's path — or nothing stored at all (`cli`): a command-line tool
 *  holds the sign-in, and the variable only says how to sign in and how to check. */
export type CredentialVarKind = 'text' | 'file' | 'cli' | 'oauth';

/** A command per platform (`darwin` / `linux` / `win32`) — a `cli` variable's `login` and `check`. */
export interface CredentialVarCommand {
  commands: Record<string, string>;
}

/** One environment variable a credential is made of, as the manifest declares it. */
export interface CredentialVar {
  label?: string;
  hint?: string;
  placeholder?: string;
  /** Backend default is `MUST` — see `isRequired`, never read this raw. A manifest or row
   *  written before the enum may still carry a boolean. */
  required?: CredentialRequirement | boolean;
  /** Regex the value must match. */
  pattern?: string;
  advanced?: boolean;
  /** Names the remote account (GMAIL_ADDRESS). Descriptive only. */
  account_key?: boolean;
  /** Backend default is TRUE — see `isSecret`, never read this raw. */
  secret?: boolean;
  /** Where to obtain THIS value; differs per member within one credential. */
  help_url?: string;
  /** `ONE_OF`: the way this variable belongs to — members sharing one are given together. Empty: its own name. */
  way?: string;
  /** Backend default is `text`. */
  kind?: CredentialVarKind;
  /** `cli` only: what the person runs to sign in, and the command whose exit 0 means signed in. */
  login?: CredentialVarCommand | null;
  check?: CredentialVarCommand | null;
}

type Weighed = { required?: CredentialRequirement | boolean };

/**
 * `required` defaults `MUST` and `secret` defaults TRUE on the backend, and a
 * manifest that accepts the default sends NOTHING. Reading `v.secret` directly
 * would treat the common case as `false` — the unsafe direction for a secret;
 * reading `v.required` for truth would treat `'OPTIONAL'` (a non-empty string) as
 * required. `ONE_OF` is neither: it is needed only as a group — see `missingNeeds`.
 */
export function requirementOf(v: Weighed | undefined): CredentialRequirement {
  const r = v?.required;
  if (r === false) return CredentialRequirement.OPTIONAL;
  return r === CredentialRequirement.OPTIONAL || r === CredentialRequirement.ONE_OF ? r : CredentialRequirement.MUST;
}
/** Needed by itself. A `ONE_OF` variable is not: its group is. */
export function isRequired(v: Weighed | undefined): boolean {
  return requirementOf(v) === CredentialRequirement.MUST;
}

/** A store keeps a value for it — not a sign-in (`cli`) or a grant (`oauth`), which live elsewhere. */
export function holdsValue(v: { kind?: string }): boolean {
  return v.kind !== 'cli' && v.kind !== 'oauth';
}

/** The either-or group: every `ONE_OF` variable of one credential. */
export function oneOfGroup<T extends Weighed>(vars: readonly T[]): T[] {
  return vars.filter((v) => requirementOf(v) === CredentialRequirement.ONE_OF);
}
type Member = Weighed & { present: boolean; env_var?: string; way?: string };

/** How a `ONE_OF` way of several variables is offered (`CredentialSpec.ways`, keyed by way name). */
export interface CredentialWay {
  label?: string;
  hint?: string;
}

/** Every member of one way is present — or there is no group to satisfy. A way is the members sharing a `way`;
 *  a member with none is a way by itself. Once a way is chosen on this machine (`choice`: the status row's
 *  `setup_choice`, a way's name — a member's name counts as its way), that way alone. */
export function groupSatisfied(vars: readonly Member[], choice = ''): boolean {
  const group = oneOfGroup(vars);
  if (group.length === 0) return true;
  // The ways, grouped once: members sharing a `way`, else each member by itself.
  const ways = new Map<string | Member, Member[]>();
  for (const v of group) {
    const key = v.way || v;
    const members = ways.get(key);
    if (members) members.push(v);
    else ways.set(key, [v]);
  }
  const wayOf = (v: Member) => v.way || v.env_var || '';
  const named = choice ? group.find((v) => v.env_var === choice) : undefined;
  const chosen = named ? wayOf(named) : choice;
  return [...ways.values()].some((members) => (!chosen || wayOf(members[0]) === chosen) && members.every((o) => o.present));
}
/**
 * What is still needed, one entry per need: each absent `MUST` variable by itself, then the group
 * — ALL its members, of which one is enough — when none is present. Its length is how many things
 * are missing; an entry of several reads "A or B".
 */
export function missingNeeds<T extends Weighed & { present: boolean }>(vars: readonly T[]): T[][] {
  const needs = vars.filter((v) => isRequired(v) && !v.present).map((v) => [v]);
  return groupSatisfied(vars) ? needs : [...needs, oneOfGroup(vars)];
}
export function isSecret(v: CredentialVar | undefined): boolean {
  return v?.secret !== false;
}

export interface ICredential extends IEntity {
  title?: string;
  description?: string;
  /** What it is needed for, in one line, and the full reason behind the info icon. */
  needed_for?: string;
  justification?: string;
  icon_name?: string;
  help_url?: string;
  setup_wiki?: string;
  /** How an agent obtains and stores the values (`flow project setup`'s AI setup). */
  setup?: string;
  /** How long an agent following `setup` gets (seconds); unset = the default. */
  setup_timeout_seconds?: number | null;
  /** The LLM API provider this credential's single key funds, if any. */
  lm_provider?: string;
  vars?: Record<string, CredentialVar>;
  /** `ONE_OF`: how each way of several variables is offered, by way name. */
  ways?: Record<string, CredentialWay>;
  manifest_schema?: number;
  /** `user` | `project` | `system` (a shipped template). */
  scope?: string | null;
  project_id?: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Credential extends EntityMerge<ICredential> {}

@registerEntity
export class Credential extends APIEntity<Credential> implements ICredential {
  static type: string = 'credential';

  title: string = '';
  description: string = '';
  needed_for: string = '';
  justification: string = '';
  /** A lucide glyph for THIS provider. Not `icon`: `APIEntity.icon` is a getter. */
  icon_name: string = '';
  help_url: string = '';
  setup_wiki: string = '';
  setup: string = '';
  setup_timeout_seconds: number | null = null;
  lm_provider: string = '';
  vars: Record<string, CredentialVar> = {};
  ways: Record<string, CredentialWay> = {};
  manifest_schema: number = 2;

  /**
   * Re-apply the payload after construction: `useDefineForClassFields: false`
   * emits every initializer above AFTER `super(json)`, so a list-query row would
   * otherwise arrive with `vars` as `{}`.
   */
  constructor(json: ICredential | undefined = undefined) {
    super(json as never);
    if (json) dataManager.deepAssign(this, json);
  }

  /** Every variable, in manifest order. */
  get varNames(): string[] {
    return Object.keys(this.vars ?? {});
  }

  /** The variables needed by themselves; a `ONE_OF` group is weighed with `missingNeeds`. */
  get requiredVarNames(): string[] {
    return Object.entries(this.vars ?? {})
      .filter(([, v]) => isRequired(v))
      .map(([k]) => k);
  }

  /** A shipped catalogue entry — added to a scope, never used directly. */
  get isTemplate(): boolean {
    return this.scope === 'system';
  }
}

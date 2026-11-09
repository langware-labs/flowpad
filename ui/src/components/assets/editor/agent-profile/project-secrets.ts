/**
 * The agent's credentials as the Env tab, the deploy dialog and a deployment's Secrets show them — names only.
 *
 * Names are project Credentials the agent requires (`agent.json` → `requirements`, kind `credential`); values live
 * in the project's hub store (`project/<id>/env-var`, write-only), which answers only which names are set. A
 * deployment may override a value on top of the project's.
 *
 * Pure and React-free: the joins are what the tests pin.
 */
import type { AgentRequirement, CredentialsStatus, DeploymentSecretsInventory } from '@sdk';

/** `set`: the project store holds every variable. `missing`: not yet. `undeclared`: the project declares no such Credential. */
export type SecretStatus = 'set' | 'missing' | 'undeclared';

/** A Credential the project declares: its name and variables. */
export interface DeclaredCredential {
  name: string;
  vars: string[];
}

/** How many of the agent's cloud deployments carry a credential's values. */
export interface Placed {
  on: number;
  of: number;
}

export interface SecretRow {
  name: string;
  vars: string[];
  status: SecretStatus;
}

/** The agent's credential requirements, one per name (a later entry adds its variables). */
export function requiredCredentials(requirements: AgentRequirement[] | null | undefined): DeclaredCredential[] {
  const out = new Map<string, string[]>();
  for (const req of requirements ?? []) {
    if (req.kind !== 'credential' || !req.name) continue;
    out.set(req.name, [...new Set([...(out.get(req.name) ?? []), ...(req.vars ?? [])])]);
  }
  return [...out].map(([name, vars]) => ({ name, vars }));
}

/** The Credentials the project itself declares, from `credentialsService.status(projectId)`. */
export function projectCredentials(status: CredentialsStatus): DeclaredCredential[] {
  return status.credentials
    .filter((row) => row.scope === 'project')
    .map((row) => ({ name: row.name, vars: row.vars.map((v) => v.env_var) }));
}

/**
 * One row per required credential. `declared`: the project's Credentials, `null` when they cannot be read here (the
 * hub page) — then nothing reads as undeclared. A declared Credential's variables win over the requirement's.
 */
export function secretRows(
  required: DeclaredCredential[],
  declared: DeclaredCredential[] | null,
  setNames: Iterable<string>,
): SecretRow[] {
  const held = new Set(setNames);
  const byName = new Map((declared ?? []).map((c) => [c.name, c]));
  return required.map((req) => {
    const own = byName.get(req.name);
    const vars = own && own.vars.length > 0 ? own.vars : req.vars;
    if (declared !== null && !own) return { name: req.name, vars, status: 'undeclared' };
    const set = vars.length > 0 && vars.every((v) => held.has(v));
    return { name: req.name, vars, status: set ? 'set' : 'missing' };
  });
}

/** What the Env tab's badge counts: required credentials the project does not declare. */
export function undeclaredCount(rows: SecretRow[]): number {
  return rows.filter((r) => r.status === 'undeclared').length;
}

/** Per credential, on how many of the deployments' machines every variable was last placed. */
export function placedOn(rows: SecretRow[], inventories: DeploymentSecretsInventory[]): Record<string, Placed> {
  const out: Record<string, Placed> = {};
  for (const row of rows) {
    const on = inventories.filter((inv) =>
      row.vars.every((v) => inv.secrets.some((s) => s.name === v && s.placed?.event === 'placed')),
    ).length;
    out[row.name] = { on: row.vars.length > 0 ? on : 0, of: inventories.length };
  }
  return out;
}

/** One deployment's Secrets row: the project's value, or this deployment's own over it. */
export interface OverrideRow {
  name: string;
  vars: string[];
  overridden: boolean;
}

/** The required credentials at one deployment: overridden when its own store holds any of the variables. */
export function overrideRows(required: DeclaredCredential[], inventory: DeploymentSecretsInventory): OverrideRow[] {
  const own = new Set(inventory.secrets.map((s) => s.name));
  return required.map((c) => ({ name: c.name, vars: c.vars, overridden: c.vars.some((v) => own.has(v)) }));
}

/** The deploy dialog's Secrets line: one mark per required credential, ✓ only when the project holds every value. */
export interface DeploySecretMark {
  name: string;
  ok: boolean;
}

export function deploySecretMarks(rows: SecretRow[]): { marks: DeploySecretMark[]; missing: number } {
  const marks = rows.map((r) => ({ name: r.name, ok: r.status === 'set' }));
  return { marks, missing: marks.filter((m) => !m.ok).length };
}

import { describe, expect, it } from 'vitest';
import type { AgentRequirement, CredentialsStatus, DeploymentSecretsInventory } from '@sdk';

import {
  deploySecretMarks,
  overrideRows,
  placedOn,
  projectCredentials,
  requiredCredentials,
  secretRows,
  undeclaredCount,
} from '@src/components/assets/editor/agent-profile/project-secrets';

const req = (name: string, vars: string[], kind: AgentRequirement['kind'] = 'credential'): AgentRequirement => ({
  kind,
  name,
  vars,
  scopes: [],
  on: '',
  why: '',
  derived: false,
  used_by: [],
});

const XHOSTD = { name: 'xhostd', vars: ['XHOSTD_TOKEN'] };

const inventory = (placed: string[], held: string[] = placed): DeploymentSecretsInventory => ({
  secrets: held.map((name) => ({ name, ...(placed.includes(name) ? { placed: { ts: 1, event: 'placed' } } : {}) })),
  authorizations: [],
});

describe('the Env tab rows', () => {
  it('takes only credential requirements, one per name', () => {
    const reqs = [req('xhostd', ['XHOSTD_TOKEN']), req('permission.mail', [], 'permission'), req('xhostd', ['EXTRA'])];
    expect(requiredCredentials(reqs)).toEqual([{ name: 'xhostd', vars: ['XHOSTD_TOKEN', 'EXTRA'] }]);
    expect(requiredCredentials(null)).toEqual([]);
  });

  it('reads the project scope of a credentials status only', () => {
    const status = {
      credentials: [
        { name: 'xhostd', scope: 'project', vars: [{ env_var: 'XHOSTD_TOKEN' }] },
        { name: 'openai', scope: 'user', vars: [{ env_var: 'OPENAI_API_KEY' }] },
      ],
    } as unknown as CredentialsStatus;
    expect(projectCredentials(status)).toEqual([XHOSTD]);
  });

  it('is Not declared when the project does not declare it, and the badge counts it', () => {
    const rows = secretRows([XHOSTD], [], []);
    expect(rows).toEqual([{ name: 'xhostd', vars: ['XHOSTD_TOKEN'], status: 'undeclared' }]);
    expect(undeclaredCount(rows)).toBe(1);
  });

  it('is Missing once declared without a value, Set once the project store holds every variable', () => {
    expect(secretRows([XHOSTD], [XHOSTD], [])[0].status).toBe('missing');
    expect(secretRows([XHOSTD], [XHOSTD], ['XHOSTD_TOKEN'])[0].status).toBe('set');
    const two = { name: 'aws', vars: ['AWS_KEY', 'AWS_SECRET'] };
    expect(secretRows([two], [two], ['AWS_KEY'])[0].status).toBe('missing');
  });

  it('never reads as Not declared where the declarations cannot be read (the hub page)', () => {
    const rows = secretRows([XHOSTD], null, ['XHOSTD_TOKEN']);
    expect(rows[0].status).toBe('set');
    expect(undeclaredCount(rows)).toBe(0);
  });

  it("uses the declared Credential's variables over the requirement's", () => {
    const declared = { name: 'xhostd', vars: ['XHOSTD_API_TOKEN'] };
    expect(secretRows([XHOSTD], [declared], ['XHOSTD_API_TOKEN'])[0]).toEqual({ ...declared, status: 'set' });
  });

  it('counts the machines every variable was placed on', () => {
    const rows = secretRows([XHOSTD], [XHOSTD], ['XHOSTD_TOKEN']);
    const placed = placedOn(rows, [inventory(['XHOSTD_TOKEN']), inventory([], ['XHOSTD_TOKEN']), inventory([])]);
    expect(placed).toEqual({ xhostd: { on: 1, of: 3 } });
    expect(placedOn(rows, [])).toEqual({ xhostd: { on: 0, of: 0 } });
  });
});

describe('the deploy dialog Secrets line', () => {
  it('marks a set credential ✓ and counts the missing ones, never blocking', () => {
    const rows = secretRows([XHOSTD, { name: 'openai', vars: ['OPENAI_API_KEY'] }], null, ['XHOSTD_TOKEN']);
    expect(deploySecretMarks(rows)).toEqual({
      marks: [
        { name: 'xhostd', ok: true },
        { name: 'openai', ok: false },
      ],
      missing: 1,
    });
  });

  it('is empty when the agent requires nothing', () => {
    expect(deploySecretMarks([])).toEqual({ marks: [], missing: 0 });
  });
});

describe("a deployment's Secrets", () => {
  it("is the project's value until this deployment's own store holds one", () => {
    expect(overrideRows([XHOSTD], inventory([]))).toEqual([{ ...XHOSTD, overridden: false }]);
    expect(overrideRows([XHOSTD], inventory(['XHOSTD_TOKEN']))).toEqual([{ ...XHOSTD, overridden: true }]);
  });
});

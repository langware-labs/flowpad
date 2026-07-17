/**
 * Project SECRET share, end-to-end across TWO instances via the real hub.
 *
 * The two-layer model over the wire: a VALUE-FREE reference travels
 * (where-to-fetch = provider, how-to-store = sod_store, how-to-use = env_var); a
 * value NEVER does. Alice adds a shared secret to a project and shares the
 * project; Bob accepts and sees the reference as MISSING (his machine has no
 * value) — the setup-wizard state. Asserts the pointer converged on one id and
 * that no plaintext crossed.
 *
 * Requires the local hub (8093) + two instances launched via
 *   scripts/instance_ctl.sh launch <SHARE_INST_1> && … <SHARE_INST_2>
 * Skips otherwise.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hubAvailable } from './_hub';
import { pollUntil } from './_matrix';
import { trackForCleanup } from '../_cleanup';
import {
  HUB_INST_1 as INST_1,
  HUB_INST_2 as INST_2,
  getInstance,
  instanceAvailable,
  type ResolvedInstance,
} from './_instances';

let skipReason: string | null = null;
let alice: ResolvedInstance;
let bob: ResolvedInstance;
const tempRoots: string[] = [];

const post = (apiUrl: string, p: string, body?: unknown) =>
  fetch(`${apiUrl}/api/v1${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

const get = (apiUrl: string, p: string) => fetch(`${apiUrl}/api/v1${p}`).then((r) => r.json());

function freshProjectDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowpad-secret-share-'));
  tempRoots.push(root);
  return realpathSync(root);
}

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!instanceAvailable(INST_1) || !instanceAvailable(INST_2)) {
    return void (skipReason = `launch ${INST_1} + ${INST_2} via scripts/instance_ctl.sh`);
  }
  alice = await getInstance(INST_1);
  bob = await getInstance(INST_2);
}, 30_000);

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

afterAll(() => {
  for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

// PENDING: blocked on the hub transport gap — the hub Project model drops the
// `shared_secret_origins` metadata field (extra="ignore"), so the value-free
// reference doesn't reach the receiver yet. This is the acceptance test for that
// follow-up (declare/persist the hub field, or route the reference through the
// git-asset path). See docs/secret_share.md "Gaps and follow-ups". Un-skip when
// the transport lands.
describe.skip('project secret share — two instances via the hub', () => {
  it('a value-free reference travels; the value does not; ids converge', async () => {
    // Alice: a fresh uniquely-pathed project (project id is uuid5 of the path —
    // a unique dir avoids a stale-hub-row collision).
    const dir = freshProjectDir();
    const project = trackForCleanup(
      new alice.sdk.Project({ name: `secret-share-${randomUUID().slice(0, 8)}`, fs_storage_mount_path: dir } as any),
    );
    await project.save();

    // Add a SHARED, value-free env-local secret pointer.
    const envVar = `OPENAI_${randomUUID().slice(0, 6).toUpperCase()}`;
    const add = await post(alice.apiUrl, `/graph/project/${project.id}/add-secret-pointer`, {
      name: 'openai',
      env_var: envVar,
      scope: 'shared',
      locator: { kind: 'env-local', env_key: envVar },
      sod_store: 'env-local',
    });
    expect(add.status, JSON.stringify(add)).toBe('SUCCESS');
    const aliceSecret = (add.data.secret_origins ?? []).find((s: any) => s.env_var === envVar);
    expect(aliceSecret, 'alice has the shared secret').toBeTruthy();
    const sharedTypeId: string = aliceSecret.typeid;

    // Share the project with Bob (project-share metadata carries the reference).
    const shared = await post(alice.apiUrl, `/graph/project/${project.id}/share`, {
      recipients: [bob.email],
    });
    expect(shared.status, JSON.stringify(shared)).toBe('SUCCESS');

    // Bob accepts pending project invitation(s). Project-share targets the
    // project (not a conversation); accept all project invitations to tolerate a
    // stale one, then verify THIS project below.
    const pending = await pollUntil(async () => {
      const res = await get(bob.apiUrl, '/graph/invitation');
      const list = ((res?.data ?? []) as any[]).filter((i) => i.target_type === 'project');
      return list.length ? list : null;
    }, 25_000, 'pending project invitation on bob');
    for (const inv of pending) {
      await bob.sdk.acceptInvitation({ invitation_id: inv.id! }).catch(() => undefined);
    }

    // Bob's project mirror carries the VALUE-FREE reference, converged on one id.
    const bobSecret = await pollUntil(async () => {
      const p = await get(bob.apiUrl, `/graph/project/${project.id}`);
      const origins = (p?.data?.secret_origins ?? []) as any[];
      return origins.find((s) => s.env_var === envVar) ?? null;
    }, 25_000, 'secret reference materialized on bob');

    expect(bobSecret.typeid).toBe(sharedTypeId); // convergent id across machines
    expect(bobSecret.kind).toBe('env-local');
    expect(bobSecret.sod_store).toBe('env-local');
    expect(bobSecret.locator).toMatchObject({ kind: 'env-local', env_key: envVar });

    // No plaintext value anywhere in Bob's project payload.
    const bobProjectBlob = JSON.stringify(await get(bob.apiUrl, `/graph/project/${project.id}`));
    expect(bobProjectBlob).not.toContain('sk-');

    // Bob can't resolve it yet → the setup-wizard state.
    const status = await post(bob.apiUrl, `/graph/project/${project.id}/secret-resolve-status`, {});
    const row = (status.data?.secrets ?? []).find((s: any) => s.env_var === envVar);
    expect(row?.status).toBe('missing');

    // Provide the value on Bob → it lands in HIS .env.local (git-ignored), and
    // now resolves. The value never went near the hub.
    await post(bob.apiUrl, `/graph/project/${project.id}/provide-secret`, {
      env_var: envVar,
      value: 'sk-bob-local-value',
    });
    const status2 = await post(bob.apiUrl, `/graph/project/${project.id}/secret-resolve-status`, {});
    const row2 = (status2.data?.secrets ?? []).find((s: any) => s.env_var === envVar);
    expect(row2?.status).toBe('available');
  }, 120_000);
});

/**
 * Alice shares the **spora** app (a static Claude-Design-handoff webapp — no git
 * remote) with Bob in COPY mode. Bob receives it, installs it into a project, and
 * the reception pipeline (index → setup_on_receive) spawns a headless Vibe process
 * seeded to run the `artifact-setup` skill. The served app renders in Bob's Vibe
 * display.
 *
 * This exercises the whole slick reception seam end-to-end:
 *   - copy-mode webapp-artifact carrier (folder bytes ride in the bundle),
 *   - install → `_finalize_install` → `Entity.setup_on_receive` returning a
 *     DisplayTarget pointing at a spawned agentic_process,
 *   - the Vibe webapp preview (WebappViewer → get-host) rendering the served app.
 *
 * Requires a local hub and launched dev instances (WITH frontends):
 *   scripts/instance_ctl.sh launch dev-1 && scripts/instance_ctl.sh launch dev-2
 *   (cd ui && FLOWPAD_HUB_URL=http://localhost:8093 npx vitest run --project hub spora_setup_vibe)
 *
 * Live-Claude note: the seeded `artifact-setup` run needs a live worker to serve
 * the app organically. To keep the assertion deterministic within budget (like
 * git_artifact_share_wizard), the test drives `flow app open` itself to start +
 * show the served folder — the pipeline under test is reception→setup→render, not
 * the agent's tool use. Do NOT raise the timeouts.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { HUB_URL, getAliceCreds, hubAvailable, hubLogin } from './_hub';
import { pollUntil } from './_matrix';
import {
  HUB_INST_1 as INST_1,
  HUB_INST_2 as INST_2,
  WORKTREE_ROOT,
  getInstance,
  instanceAvailable,
  readEnvFile,
  type ResolvedInstance,
} from './_instances';
import {
  launchBrowser,
  openConversation,
  openInstancePage,
  realConsoleErrors,
  resetConsoleErrors,
  type InstancePage,
} from './_browser';

const BODY_FILENAME = 'body.flowmsg';

let skipReason: string | null = null;
let alice: ResolvedInstance;
let bob: ResolvedInstance;
const tempRoots: string[] = [];
const createdProjects: Array<{ apiUrl: string; id: string }> = [];
const startedPids: number[] = [];

function pythonBin(): string {
  const venvPython = path.join(WORKTREE_ROOT, '.venv', 'bin', 'python');
  return existsSync(venvPython) ? venvPython : 'python';
}

function api(apiUrl: string, method: string, p: string, body?: unknown) {
  return fetch(`${apiUrl}/api/v1${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}
const post = (apiUrl: string, p: string, body?: unknown) => api(apiUrl, 'POST', p, body);
const put = (apiUrl: string, p: string, body?: unknown) => api(apiUrl, 'PUT', p, body);

async function backendGet(inst: ResolvedInstance, type: string, id: string): Promise<any | null> {
  const r = await fetch(`${inst.apiUrl}/api/v1/graph/${type}/${id}`).then((x) => x.json()).catch(() => null);
  return r?.status === 'SUCCESS' ? r.data : null;
}

/** A spora-like STATIC design-handoff app: index.html (+ a chats/ folder to look
 *  like a Claude Design bundle), no package.json, no git. */
function makeStaticFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowpad-spora-'));
  tempRoots.push(root);
  const appDir = path.join(root, 'spora-sim', 'project');
  mkdirSync(appDir, { recursive: true });
  const token = `spora-token-${randomUUID()}`;
  writeFileSync(
    path.join(appDir, 'index.html'),
    `<html><head><title>SPORA — Smart Home Simulator</title></head><body>${token}</body></html>\n`,
    'utf-8',
  );
  return { root, appDir, token };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function downloadHubBundle(fmId: string, zipPath: string): Promise<void> {
  const creds = await getAliceCreds();
  if (!creds || creds.email !== alice.email) throw new Error(`missing canonical hub credentials for ${alice.name}`);
  const login = await hubLogin(creds.email, creds.password);
  const r = await fetch(`${HUB_URL}/api/v1/graph/flow_message/${fmId}/fs/download/${BODY_FILENAME}`, {
    headers: { Authorization: `Bearer ${login.token}` },
  });
  if (!r.ok) throw new Error(`hub body download failed (${r.status}): ${await r.text()}`);
  writeFileSync(zipPath, Buffer.from(await r.arrayBuffer()));
}

async function waitForHubBundle(fmId: string, zipPath: string): Promise<void> {
  await pollUntil(async () => {
    try {
      await downloadHubBundle(fmId, zipPath);
      return true;
    } catch {
      return null;
    }
  }, 30_000, 'hub body bundle upload');
}

function bundleNames(zipPath: string): string[] {
  const script = [
    'import json, sys, zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as zf:',
    '    print(json.dumps(zf.namelist()))',
  ].join('\n');
  return JSON.parse(execFileSync(pythonBin(), ['-c', script, zipPath], { cwd: WORKTREE_ROOT, encoding: 'utf-8' }));
}

async function findReadyMessage(convId: string): Promise<string> {
  const fm = await pollUntil(async () => {
    await bob.sdk.fetchConversations();
    const c = await bob.sdk.Conversation.getById(convId).catch(() => null);
    for (const p of (c?.conversationMessageIds ?? []) as any[]) {
      if (p.type !== 'flow_message') continue;
      const full = await bob.sdk.FlowMessage.getById(p.id).catch(() => null);
      if (full && full.body_status === 'ready') return full;
    }
    return null;
  }, 20_000, 'shared spora message READY');
  return fm.id;
}

async function createBobProject(): Promise<{ id: string; dir: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'flowpad-bob-spora-project-'));
  tempRoots.push(dir);
  const created = await post(bob.apiUrl, '/graph/project', { name: path.basename(dir), fs_storage_mount_path: dir });
  const id = created.body?.data?.id as string;
  expect(id, 'bob project id').toBeTruthy();
  createdProjects.push({ apiUrl: bob.apiUrl, id });
  return { id, dir };
}

async function stagedAttachmentId(fmId: string, artifactId: string): Promise<string> {
  const staged = await pollUntil(async () => {
    const rows = (await bob.sdk.MessageAttachment.query(
      new bob.sdk.QueryRequest({ type: 'message_attachment', query: { flow_message_id: fmId }, name: 'staged (test)' }),
      true,
    ).catch(() => [])) as any[];
    return rows.find((r) => r.asset_id === artifactId) ?? null;
  }, 10_000, 'staged spora artifact MessageAttachment');
  return staged.id as string;
}

async function flowCliAsync(inst: ResolvedInstance, args: string[], cwd: string): Promise<string> {
  const envFile = await readEnvFile(inst.name);
  const port = new URL(inst.apiUrl).port;
  return execFileSync(pythonBin(), ['-m', 'flow_sdk.cli.flow_cli', ...args], {
    cwd,
    env: {
      ...process.env,
      ...envFile,
      FLOW_INSTANCE: inst.name,
      LOCAL_SERVER_PORT: port,
      PYTHONPATH: `${WORKTREE_ROOT}${path.delimiter}${process.env.PYTHONPATH ?? ''}`,
    },
    encoding: 'utf-8',
  });
}

async function acceptConversationInvitationInUI(inst: InstancePage, conversationId: string): Promise<void> {
  const { page } = inst;
  const rowSelector = `[data-testid="inbox-conversation-row"][data-conversation-id="${conversationId}"]`;
  const deadline = Date.now() + 35_000;
  for (;;) {
    await fetch(`${inst.apiUrl}/api/v1/graph/conversation-list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).catch(() => undefined);
    await page.goto(`${inst.feUrl}/dock/inbox?viewMode=advanced`, { waitUntil: 'domcontentloaded' });
    const row = page.locator(rowSelector).first();
    if (await row.isVisible({ timeout: 2_000 }).catch(() => false)) {
      const kind = await row.getAttribute('data-kind').catch(() => null);
      if (kind !== 'invitation') return;
      const accept = row.getByTestId('inbox-accept-invitation-button');
      if (await accept.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await accept.click({ timeout: 5_000 });
        await pollUntil(async () => {
          const invitations = await fetch(`${inst.apiUrl}/api/v1/graph/invitation`).then((x) => x.json()).catch(() => null);
          const rows = (invitations?.data ?? []) as any[];
          const inv = rows.find((i) => i?.target_url_path === `/conversation/${conversationId}`);
          return inv?.accepted === true ? true : null;
        }, 20_000, `conversation ${conversationId} invitation accepted`);
        return;
      }
    }
    if (Date.now() > deadline) throw new Error(`invitation row not accept-ready for ${conversationId}`);
    await page.waitForTimeout(1_000);
  }
}

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!instanceAvailable(INST_1) || !instanceAvailable(INST_2)) {
    return void (skipReason = `launch ${INST_1} + ${INST_2} (with frontends) via scripts/instance_ctl.sh`);
  }
  alice = await getInstance(INST_1);
  bob = await getInstance(INST_2);
}, 30_000);

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

afterAll(() => {
  for (const pid of startedPids) { try { process.kill(pid); } catch { /* gone */ } }
  for (const root of tempRoots) { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } }
});

describe('spora copy-share → Vibe setup', () => {
  it('Alice copy-shares spora; Bob installs it and the served app renders in his Vibe display', async () => {
    const fixture = makeStaticFixture();
    const artifactId = randomUUID();
    const artifactName = `spora-sim-${artifactId.slice(0, 8)}`;
    const appPort = await freePort();

    // Copy-mode WEBAPP artifact — a real folder, NO git_origin.
    const created = await post(alice.apiUrl, '/graph/artifact', {
      id: artifactId,
      name: artifactName,
      ref_type: 'FOLDER',
      path: fixture.appDir,
      artifact_type: 'WEBAPP',
      port: String(appPort),
      start_cmd: `python3 -m http.server ${appPort}`,
      health: '/',
    });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(400);

    const conv = new alice.sdk.Conversation({ title: `e2etest-spora-${Date.now()}` });
    await conv.save();
    await conv.share([bob.email]);
    expect(conv.remote).toBe(true);

    const add = await post(alice.apiUrl, `/graph/conversation/${conv.id}/add_message`, {
      message: 'set up this app',
      asset_references: [`artifact-${artifactId}`],
      shared_context_entities: [`artifact-${artifactId}`],
      share_config: { transfer_mode: 'copy' },
    });
    const fmId = add.body?.data?.flow_message_id as string;
    expect(fmId, JSON.stringify(add.body)).toBeTruthy();

    // The bundle carries the FOLDER BYTES (copy mode) + a copy transfers manifest.
    const zipPath = path.join(fixture.root, 'hub-body-spora.flowmsg');
    await waitForHubBundle(fmId, zipPath);
    const names = bundleNames(zipPath);
    expect(names).toContain('git_transfers.json');
    expect(names.some((n) => n.includes('/webapps/') && n.endsWith('/index.html'))).toBe(true);

    let browser: Browser | null = null;
    let bobPage: InstancePage | null = null;
    try {
      browser = await launchBrowser();
      bobPage = await openInstancePage(browser, INST_2);

      await acceptConversationInvitationInUI(bobPage, conv.id!);
      const bobFmId = await findReadyMessage(conv.id!);
      const download = await post(bob.apiUrl, `/graph/flow_message/${bobFmId}/download_body`, {});
      expect(download.status, JSON.stringify(download.body)).toBeLessThan(400);

      // A webapp artifact installs into a PROJECT (its served root isn't ~/.claude).
      const project = await createBobProject();
      const mapped = await put(bob.apiUrl, `/graph/conversation/${conv.id}`, { project_id: project.id });
      expect(mapped.status, JSON.stringify(mapped.body)).toBeLessThan(400);

      const maId = await stagedAttachmentId(bobFmId, artifactId);
      const install = await post(bob.apiUrl, `/graph/message_attachment/${maId}/install`, {
        scope: 'project',
        project_id: project.id,
      });
      expect(install.status, JSON.stringify(install.body)).toBeLessThan(400);

      // Install materialized the artifact row pointing at the copied served folder.
      const row = await pollUntil(() => backendGet(bob, 'artifact', artifactId), 10_000, 'spora artifact materialized');
      expect(String(row.path)).toContain(path.join(project.dir, 'webapps'));

      // …and returned a DisplayTarget for the spawned Vibe setup process.
      const show = install.body?.data?.show;
      expect(show?.type, JSON.stringify(install.body?.data)).toBe('agentic_process');
      const vibeProcId = show.id as string;
      const proc = await pollUntil(() => backendGet(bob, 'agentic_process', vibeProcId), 10_000, 'vibe setup process');
      expect(proc.context_data?.launched_from).toBe('artifact_setup');
      expect(proc.context_data?.source_artifact_id).toBe(artifactId);

      // Serve + show the app on the setup process (deterministic stand-in for the
      // seeded artifact-setup agent run), then assert it renders in the Vibe pane.
      const served = path.join(row.path);
      const appOpen = JSON.parse(await flowCliAsync(
        bob,
        ['app', 'open', artifactName, '--root', served, '--process', `agentic_process-${vibeProcId}`, '--port', String(appPort), '--timeout', '25'],
        served,
      ));
      expect(appOpen.ok, JSON.stringify(appOpen)).toBe(true);
      if (typeof appOpen.pid === 'number') startedPids.push(appOpen.pid);

      resetConsoleErrors(bobPage);
      await bobPage.page.goto(`${bobPage.feUrl}/dock/shell/agentic_process-${vibeProcId}?viewMode=vibe`, {
        waitUntil: 'domcontentloaded',
      });

      const frame = bobPage.page.locator('iframe[data-testid="vibe-webapp-frame"]').first();
      await frame.waitFor({ state: 'attached', timeout: 30_000 });
      await expect.poll(async () => {
        const handle = await frame.elementHandle();
        const content = await handle?.contentFrame();
        return (await content?.locator('body').innerText({ timeout: 2_000 }).catch(() => '')) ?? '';
      }, { timeout: 30_000 }).toContain(fixture.token);
    } finally {
      await browser?.close();
    }
  }, 150_000);
});

/**
 * Alice shares a git-backed webapp artifact with Bob.
 *
 * The body is uploaded in git mode: metadata + GitOrigin ride through the hub,
 * but the webapp files do not. Bob receives the artifact declaration, opens it,
 * gets a git setup wizard, clones the real remote, closes the wizard through
 * the real CLI path, then resolves and reads the app files from Git.
 *
 * Requires a local hub and launched dev instances:
 *   scripts/instance_ctl.sh launch dev-1 && scripts/instance_ctl.sh launch dev-2
 *   (cd ui && FLOWPAD_HUB_URL=http://localhost:8093 npx vitest run --project hub git_artifact_share_wizard)
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { HUB_URL, getAliceCreds, hubAvailable, hubLogin } from './_hub';
import { pollUntil } from './_matrix';
import {
  HUB_INST_1 as INST_1,
  HUB_INST_2 as INST_2,
  WORKTREE_ROOT,
  findPendingInvitation,
  getInstance,
  instanceAvailable,
  readEnvFile,
  type ResolvedInstance,
} from './_instances';
import {
  dismissWelcomeModal,
  launchBrowser,
  openConversation,
  openInstancePage,
  realConsoleErrors,
  resetConsoleErrors,
  type InstancePage,
} from './_browser';

const REL_PATH = 'apps/shared-webapp';
const BRANCH = 'feature/git-artifact-share';
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

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
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

/** The git artifact now rides the staged→install model: download stages a
 *  MessageAttachment; INSTALL materializes the graph row (path='', no clone —
 *  the checkout resolves at open). Poll for the staged row then install it. */
async function installStagedArtifact(inst: ResolvedInstance, fmId: string, artifactId: string): Promise<void> {
  const staged = await pollUntil(async () => {
    const rows = (await inst.sdk.MessageAttachment.query(
      new inst.sdk.QueryRequest({ type: 'message_attachment', query: { flow_message_id: fmId }, name: 'staged (test)' }),
      true,
    ).catch(() => [])) as any[];
    return rows.find((r) => r.asset_id === artifactId) ?? null;
  }, 10_000, 'staged artifact MessageAttachment');
  const install = await post(inst.apiUrl, `/graph/message_attachment/${staged.id}/install`, { scope: 'user' });
  expect(install.status, JSON.stringify(install.body)).toBeLessThan(400);
}

function makeGitFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowpad-git-artifact-share-'));
  tempRoots.push(root);
  const remote = path.join(root, 'remote.git');
  const senderRepo = path.join(root, 'alice-worktree');
  const appDir = path.join(senderRepo, REL_PATH);
  const token = `git-artifact-token-${randomUUID()}`;

  git(root, 'init', '--bare', '-q', remote);
  git(root, 'clone', '-q', pathToFileURL(remote).href, senderRepo);
  git(senderRepo, 'checkout', '-q', '-b', BRANCH);
  git(senderRepo, 'config', 'user.email', 'alice@example.test');
  git(senderRepo, 'config', 'user.name', 'Alice');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(path.join(appDir, 'index.html'), `<html><body>${token}</body></html>\n`, 'utf-8');
  git(senderRepo, 'add', '-A');
  git(senderRepo, 'commit', '-qm', 'webapp');
  git(senderRepo, 'push', '-q', '-u', 'origin', BRANCH);

  const remoteUri = pathToFileURL(remote).href;
  return {
    root,
    remote,
    remoteUri,
    senderRepo,
    appDir,
    token,
    gitOrigin: {
      provider: 'file',
      owner: path.dirname(remote),
      name: path.basename(remote, '.git'),
      branch: BRANCH,
      rel_path: REL_PATH,
    },
  };
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

function inspectBundle(zipPath: string, metadataName: string): { names: string[]; metadata: any } {
  const script = [
    'import json, sys, zipfile',
    'zip_path, meta = sys.argv[1], sys.argv[2]',
    'with zipfile.ZipFile(zip_path) as zf:',
    '    names = zf.namelist()',
    '    data = json.loads(zf.read(meta).decode("utf-8"))',
    'print(json.dumps({"names": names, "metadata": data}))',
  ].join('\n');
  return JSON.parse(execFileSync(pythonBin(), ['-c', script, zipPath, metadataName], {
    cwd: WORKTREE_ROOT,
    encoding: 'utf-8',
  }));
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
  }, 20_000, 'shared git artifact message READY');
  return fm.id;
}

async function acceptAndFindReadyMessage(convId: string): Promise<string> {
  const invitation = await pollUntil(() => findPendingInvitation(bob, convId), 20_000, 'pending invitation');
  await bob.sdk.acceptInvitation({ invitation_id: invitation.id! });
  return findReadyMessage(convId);
}

async function createBobProject(): Promise<{ id: string; dir: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'flowpad-bob-git-project-'));
  tempRoots.push(dir);
  const created = await post(bob.apiUrl, '/graph/project', {
    name: path.basename(dir),
    fs_storage_mount_path: dir,
  });
  const id = created.body?.data?.id as string;
  expect(id, 'bob project id').toBeTruthy();
  createdProjects.push({ apiUrl: bob.apiUrl, id });
  return { id, dir };
}

async function findGitSetupWizardProcessId(artifactId: string): Promise<string> {
  const row = await pollUntil(async () => {
    const r = await fetch(`${bob.apiUrl}/api/v1/graph/agentic_process?limit=100`)
      .then((x) => x.json())
      .catch(() => null);
    const rows = (r?.data ?? []) as any[];
    return rows.find((p) => {
      const wizard = p?.context_data?.wizard;
      return p?.process_type === 'wizard'
        && wizard?.name === 'git-setup'
        && wizard?.data?.payload?.artifactId === artifactId;
    }) ?? null;
  }, 15_000, 'git setup wizard process');
  return row.id as string;
}

async function launchAndCloseGitWizard(localPath: string, projectId: string): Promise<void> {
  const sdk: any = bob.sdk;
  const proc = await new sdk.AgenticProcess({
    process_type: sdk.ProcessKind.Wizard,
    visible: false,
    pty_mode: false,
    load_flowpad_assistant: false,
    context_data: { wizard: { name: 'git-setup' } },
  }).save([]);
  await proc.watch();
  const awaited = sdk.awaitWizardResult(proc, { timeoutMs: 15_000 });

  const envFile = await readEnvFile(bob.name);
  const closePayload = JSON.stringify({
    status: 'done',
    data: { localPath, projectId },
  });
  const port = new URL(bob.apiUrl).port;
  const stdout = execFileSync(
    pythonBin(),
    ['-m', 'flow_sdk.cli.flow_cli', 'wizard', `agentic_process-${proc.id}`, 'close', closePayload],
    {
      cwd: WORKTREE_ROOT,
      env: {
        ...process.env,
        ...envFile,
        FLOW_INSTANCE: bob.name,
        LOCAL_SERVER_PORT: port,
        PYTHONPATH: `${WORKTREE_ROOT}${path.delimiter}${process.env.PYTHONPATH ?? ''}`,
      },
      encoding: 'utf-8',
    },
  );
  expect(JSON.parse(stdout).ok).toBe(true);
  await expect(awaited).resolves.toMatchObject({
    status: 'done',
    data: { localPath, projectId },
  });
}

async function closeUiGitWizard(processId: string, localPath: string, projectId: string): Promise<void> {
  const envFile = await readEnvFile(bob.name);
  const closePayload = JSON.stringify({
    status: 'done',
    data: { localPath, projectId },
  });
  const port = new URL(bob.apiUrl).port;
  const stdout = execFileSync(
    pythonBin(),
    ['-m', 'flow_sdk.cli.flow_cli', 'wizard', `agentic_process-${processId}`, 'close', closePayload],
    {
      cwd: WORKTREE_ROOT,
      env: {
        ...process.env,
        ...envFile,
        FLOW_INSTANCE: bob.name,
        LOCAL_SERVER_PORT: port,
        PYTHONPATH: `${WORKTREE_ROOT}${path.delimiter}${process.env.PYTHONPATH ?? ''}`,
      },
      encoding: 'utf-8',
    },
  );
  expect(JSON.parse(stdout).ok).toBe(true);
}

async function acceptConversationInvitationInUI(inst: InstancePage, conversationId: string): Promise<void> {
  const { page } = inst;
  const rowSelector = `[data-testid="inbox-conversation-row"][data-conversation-id="${conversationId}"]`;
  const deadline = Date.now() + 35_000;
  let lastState = '(not rendered)';

  for (;;) {
    await fetch(`${inst.apiUrl}/api/v1/graph/conversation-list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).catch(() => undefined);

    await page.goto(`${inst.feUrl}/dock/inbox?viewMode=advanced`, { waitUntil: 'domcontentloaded' });
    await dismissWelcomeModal(page);

    const row = page.locator(rowSelector).first();
    if (await row.isVisible({ timeout: 2_000 }).catch(() => false)) {
      lastState = await row.innerText().catch(() => '(row text unavailable)');
      const kind = await row.getAttribute('data-kind').catch(() => null);
      if (kind !== 'invitation') return;

      const accept = row.getByTestId('inbox-accept-invitation-button');
      if (await accept.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await accept.click({ timeout: 5_000 });
        await pollUntil(async () => {
          const invitations = await fetch(`${inst.apiUrl}/api/v1/graph/invitation`)
            .then((x) => x.json())
            .catch(() => null);
          const rows = (invitations?.data ?? []) as any[];
          const inv = rows.find((i) => i?.target_url_path === `/conversation/${conversationId}`);
          return inv?.accepted === true ? true : null;
        }, 20_000, `conversation ${conversationId} invitation accepted`);
        return;
      }
    }

    if (Date.now() > deadline) {
      throw new Error(
        `conversation invitation row did not become accept-ready for ${conversationId}. Last state: ${lastState}`,
      );
    }
    await page.waitForTimeout(1_000);
  }
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

afterAll(async () => {
  for (const pid of startedPids) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already exited */
      }
    }
  }
  if (alice && bob) {
    for (const p of createdProjects) {
      await fetch(`${p.apiUrl}/api/v1/graph/project/${p.id}`, { method: 'DELETE' }).catch(() => undefined);
    }
  }
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('hub: git-backed artifact share wizard', () => {
  it('Alice sends metadata+GitOrigin; Bob sets up git through wizard and reads the webapp files', async () => {
    const fixture = makeGitFixture();
    const artifactId = randomUUID();
    const artifactName = `e2etest-git-webapp-${artifactId.slice(0, 8)}`;
    const artifactPayload = {
      id: artifactId,
      name: artifactName,
      ref_type: 'FOLDER',
      path: fixture.appDir,
      artifact_type: 'WEBAPP',
      port: '45679',
      git_origin: fixture.gitOrigin,
      metadata: {
        port: '45679',
        git_origin: fixture.gitOrigin,
      },
    };

    const createdArtifact = await post(alice.apiUrl, '/graph/artifact', artifactPayload);
    expect(createdArtifact.status, JSON.stringify(createdArtifact.body)).toBeLessThan(400);
    expect(createdArtifact.body?.data?.id).toBe(artifactId);

    const conv = new alice.sdk.Conversation({ title: `e2etest-git-artifact-${Date.now()}` });
    await conv.save();
    await conv.share([bob.email]);
    expect(conv.remote).toBe(true);

    const add = await post(alice.apiUrl, `/graph/conversation/${conv.id}/add_message`, {
      message: 'git webapp for you',
      asset_references: [`artifact-${artifactId}`],
      share_config: { transfer_mode: 'git' },
    });
    const fmId = add.body?.data?.flow_message_id as string;
    expect(fmId, JSON.stringify(add.body)).toBeTruthy();

    const zipPath = path.join(fixture.root, 'hub-body.flowmsg');
    const metadataName = `metadata/artifact-@${artifactId}/metadata.json`;
    await waitForHubBundle(fmId, zipPath);
    const inspected = inspectBundle(zipPath, metadataName);
    expect(inspected.names).toContain('git_origins.json');
    expect(inspected.names).toContain('git_transfers.json');
    expect(inspected.names).toContain(metadataName);
    expect(inspected.metadata.path).toBe(fixture.appDir);
    expect(inspected.metadata.git_origin.rel_path).toBe(REL_PATH);
    expect(inspected.names.some((name) => name.endsWith('/index.html'))).toBe(false);

    const bobFmId = await acceptAndFindReadyMessage(conv.id!);
    const download = await post(bob.apiUrl, `/graph/flow_message/${bobFmId}/download_body`, {});
    expect(download.status, JSON.stringify(download.body)).toBeLessThan(400);

    // Staged at download; explicit install materializes the graph row.
    await installStagedArtifact(bob, bobFmId, artifactId);
    const receivedArtifact = await pollUntil(
      () => backendGet(bob, 'artifact', artifactId),
      10_000,
      'git artifact materialized on Bob',
    );
    expect(receivedArtifact.git_origin?.rel_path).toBe(REL_PATH);
    expect(receivedArtifact.path || '').toBe('');

    const project = await createBobProject();
    const beforeWizard = await post(bob.apiUrl, `/graph/artifact/${artifactId}/resolve-git-location`, {
      current_project_id: project.id,
    });
    expect(beforeWizard.body?.data?.kind, JSON.stringify(beforeWizard.body)).toBe('needs_wizard');

    git(path.dirname(project.dir), 'clone', '-q', '--branch', BRANCH, fixture.remoteUri, project.dir);
    await launchAndCloseGitWizard(project.dir, project.id);

    const ready = await post(bob.apiUrl, `/graph/artifact/${artifactId}/resolve-git-location`, {
      current_project_id: project.id,
      local_path: project.dir,
      project_id: project.id,
    });
    expect(ready.body?.data?.kind, JSON.stringify(ready.body)).toBe('ready');
    const localPath = ready.body.data.localPath as string;
    expect(readFileSync(path.join(localPath, 'index.html'), 'utf-8')).toContain(fixture.token);
  }, 45_000);

  it('Alice shares a git-backed app; Bob opens the artifact chip into Vibe and the app renders', async () => {
    const fixture = makeGitFixture();
    const artifactId = randomUUID();
    const artifactName = `e2etest-git-vibe-webapp-${artifactId.slice(0, 8)}`;
    const appPort = await freePort();
    expect(appPort).toBeGreaterThan(0);
    const artifactPayload = {
      id: artifactId,
      name: artifactName,
      ref_type: 'FOLDER',
      path: fixture.appDir,
      artifact_type: 'WEBAPP',
      port: String(appPort),
      start_cmd: `python3 -m http.server ${appPort}`,
      health: '/',
      git_origin: fixture.gitOrigin,
      metadata: {
        port: String(appPort),
        start_cmd: `python3 -m http.server ${appPort}`,
        health: '/',
        git_origin: fixture.gitOrigin,
      },
    };

    const createdArtifact = await post(alice.apiUrl, '/graph/artifact', artifactPayload);
    expect(createdArtifact.status, JSON.stringify(createdArtifact.body)).toBeLessThan(400);

    const conv = new alice.sdk.Conversation({ title: `e2etest-git-vibe-${Date.now()}` });
    await conv.save();
    await conv.share([bob.email]);
    expect(conv.remote).toBe(true);

    const add = await post(alice.apiUrl, `/graph/conversation/${conv.id}/add_message`, {
      message: 'open this git-backed app in vibe',
      asset_references: [`artifact-${artifactId}`],
      shared_context_entities: [`artifact-${artifactId}`],
      share_config: { transfer_mode: 'git' },
    });
    const fmId = add.body?.data?.flow_message_id as string;
    expect(fmId, JSON.stringify(add.body)).toBeTruthy();

    const zipPath = path.join(fixture.root, 'hub-body-vibe.flowmsg');
    await waitForHubBundle(fmId, zipPath);
    const inspected = inspectBundle(zipPath, `metadata/artifact-@${artifactId}/metadata.json`);
    expect(inspected.names).toContain('git_origins.json');
    expect(inspected.names).toContain('git_transfers.json');
    expect(inspected.names.some((name) => name.endsWith('/index.html'))).toBe(false);

    let browser: Browser | null = null;
    let bobPage: InstancePage | null = null;
    try {
      browser = await launchBrowser();
      bobPage = await openInstancePage(browser, INST_2);

      await acceptConversationInvitationInUI(bobPage, conv.id!);
      const bobFmId = await findReadyMessage(conv.id!);
      const download = await post(bob.apiUrl, `/graph/flow_message/${bobFmId}/download_body`, {});
      expect(download.status, JSON.stringify(download.body)).toBeLessThan(400);
      // Staged at download; install materializes the artifact so its chip resolves.
      await installStagedArtifact(bob, bobFmId, artifactId);
      await pollUntil(
        () => backendGet(bob, 'artifact', artifactId),
        10_000,
        'git artifact materialized on Bob',
      );

      const project = await createBobProject();
      const mapped = await put(bob.apiUrl, `/graph/conversation/${conv.id}`, { project_id: project.id });
      expect(mapped.status, JSON.stringify(mapped.body)).toBeLessThan(400);

      await openConversation(bobPage, conv.id!);
      resetConsoleErrors(bobPage);
      await bobPage.page.getByTestId(`entity-chip-artifact-${artifactId}`).click({ timeout: 20_000 });

      const wizardId = await findGitSetupWizardProcessId(artifactId);
      git(path.dirname(project.dir), 'clone', '-q', '--branch', BRANCH, fixture.remoteUri, project.dir);
      await closeUiGitWizard(wizardId, project.dir, project.id);

      const vibeProcess = await pollUntil(async () => {
        const r = await fetch(`${bob.apiUrl}/api/v1/graph/agentic_process?limit=100`)
          .then((x) => x.json())
          .catch(() => null);
        const rows = (r?.data ?? []) as any[];
        return rows.find((p) => (
          p?.process_type === 'chat'
          && p?.context_data?.launched_from === 'git_artifact_share'
          && p?.context_data?.source_artifact_id === artifactId
        )) ?? null;
      }, 20_000, 'Vibe app-open process');

      // Vibe's process surface is the DISPLAY dock (process-dock-canonicalization:
      // vibe → /dock/display/…, standard → /dock/shell/…).
      await bobPage.page.waitForURL(/\/dock\/display\/agentic_process-.*viewMode=vibe/, { timeout: 20_000 });
      const appOpen = JSON.parse(await flowCliAsync(
        bob,
        ['app', 'open', artifactName, '--root', project.dir, '--process', `agentic_process-${vibeProcess.id}`, '--port', String(appPort), '--timeout', '25'],
        project.dir,
      ));
      expect(appOpen.ok).toBe(true);
      if (typeof appOpen.pid === 'number') startedPids.push(appOpen.pid);

      const frame = bobPage.page.locator('iframe[data-testid="vibe-webapp-frame"]').first();
      await frame.waitFor({ state: 'attached', timeout: 30_000 });
      await expect.poll(async () => {
        const handle = await frame.elementHandle();
        const content = await handle?.contentFrame();
        return await content?.locator('body').innerText({ timeout: 2_000 }).catch(() => '') ?? '';
      }, { timeout: 30_000 }).toContain(fixture.token);
      expect(realConsoleErrors(bobPage.consoleErrors)).toEqual([]);
    } finally {
      await browser?.close();
    }
  }, 150_000);
});

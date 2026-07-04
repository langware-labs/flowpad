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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { HUB_URL, hubAvailable, hubLogin } from './_hub';
import { pollUntil } from './_matrix';
import {
  WORKTREE_ROOT,
  findPendingInvitation,
  getInstance,
  instanceAvailable,
  readEnvFile,
  type ResolvedInstance,
} from './_instances';

const INST_1 = process.env.SHARE_INST_1 || 'dev-1';
const INST_2 = process.env.SHARE_INST_2 || 'dev-2';
const REL_PATH = 'apps/shared-webapp';
const BRANCH = 'feature/git-artifact-share';
const BODY_FILENAME = 'body.flowmsg';

let skipReason: string | null = null;
let alice: ResolvedInstance;
let bob: ResolvedInstance;
const tempRoots: string[] = [];
const createdProjects: Array<{ apiUrl: string; id: string }> = [];

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

async function downloadHubBundle(fmId: string, zipPath: string): Promise<void> {
  const env = await readEnvFile(alice.name);
  const email = env.FLOWPAD_CLOUD_USER_EMAIL || alice.email;
  const password = env.FLOWPAD_CLOUD_USER_PASSWORD;
  if (!email || !password) throw new Error(`missing hub password for ${alice.name}`);
  const login = await hubLogin(email, password);
  const r = await fetch(`${HUB_URL}/api/v1/graph/flow_message/${fmId}/fs/download/${BODY_FILENAME}`, {
    headers: { Authorization: `Bearer ${login.token}` },
  });
  if (!r.ok) throw new Error(`hub body download failed (${r.status}): ${await r.text()}`);
  writeFileSync(zipPath, Buffer.from(await r.arrayBuffer()));
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

async function acceptAndFindReadyMessage(convId: string): Promise<string> {
  const invitation = await pollUntil(() => findPendingInvitation(bob, convId), 20_000, 'pending invitation');
  await bob.sdk.acceptInvitation({ invitation_id: invitation.id! });
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

beforeAll(async () => {
  const hub = await hubAvailable();
  if (!hub.ok) return void (skipReason = hub.reason ?? 'hub unreachable');
  if (!(await instanceAvailable(INST_1)) || !(await instanceAvailable(INST_2))) {
    return void (skipReason = `launch ${INST_1} + ${INST_2} via scripts/instance_ctl.sh`);
  }
  const aliceEnv = await readEnvFile(INST_1);
  if (!aliceEnv.FLOWPAD_CLOUD_USER_EMAIL || !aliceEnv.FLOWPAD_CLOUD_USER_PASSWORD) {
    return void (skipReason = `${INST_1} is missing FLOWPAD_CLOUD_USER_EMAIL/PASSWORD`);
  }
  alice = await getInstance(INST_1);
  bob = await getInstance(INST_2);
}, 30_000);

beforeEach((context: any) => {
  if (skipReason) context.skip();
});

afterAll(async () => {
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
    });
    const fmId = add.body?.data?.flow_message_id as string;
    expect(fmId, JSON.stringify(add.body)).toBeTruthy();

    const upload = await post(alice.apiUrl, `/graph/flow_message/${fmId}/upload_body`, {
      transfer_mode: 'git',
    });
    expect(upload.body?.data?.body_status, JSON.stringify(upload.body)).toBe('ready');

    const zipPath = path.join(fixture.root, 'hub-body.flowmsg');
    const metadataName = `metadata/artifact-@${artifactId}/metadata.json`;
    await downloadHubBundle(fmId, zipPath);
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
});

/**
 * CloudNSite install-link release gate.
 *
 * This is intentionally opt-in: it launches two real cloud workspaces against
 * a fresh, private, auto-initialized GitHub repository created for this CI run.
 * Within this spec, the verification token is used only by Node's fetch below;
 * it is never put in the browser context, page data, or trace.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const REVIEW_BRANCH = 'flowpad/install-cloudnsite-agents';
const INSTALL_NAME = 'CloudNSite Agents';
const JOURNEY_NAME = 'Start using CloudNSite agents';
const CONTENT_REPO_DEFAULT = 'https://github.com/langware-labs/langware-support';
const CONTENT_BRANCH_DEFAULT = 'demo/cloudnsite-agents';
const QUEUE_PROJECT_ID_DEFAULT = '4f9f1fd1-39b6-5465-9c20-cb4c59b08318';
const GITHUB_API_DEFAULT = 'https://api.github.com';
const RUN_MARKER = process.env.CLOUDNSITE_E2E_RUN_ID?.trim() || `cloudnsite-e2e-${Date.now()}-${process.pid}`;
const UUID_V4_OR_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPO_SLUG = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const SAFE_BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

const rawEnv = {
  hubUrl: process.env.CLOUDNSITE_E2E_HUB_URL?.trim() ?? '',
  email: process.env.CLOUDNSITE_E2E_EMAIL?.trim() ?? '',
  password: process.env.CLOUDNSITE_E2E_PASSWORD ?? '',
  contentRepo: process.env.CLOUDNSITE_E2E_CONTENT_REPO?.trim() || CONTENT_REPO_DEFAULT,
  contentBranch: process.env.CLOUDNSITE_E2E_CONTENT_BRANCH?.trim() || CONTENT_BRANCH_DEFAULT,
  targetRepo: process.env.CLOUDNSITE_E2E_TARGET_REPO?.trim() ?? '',
  targetBranch: process.env.CLOUDNSITE_E2E_TARGET_BRANCH?.trim() ?? '',
  queueProjectId: process.env.CLOUDNSITE_E2E_QUEUE_PROJECT_ID?.trim() || QUEUE_PROJECT_ID_DEFAULT,
  githubToken: process.env.CLOUDNSITE_E2E_GITHUB_TOKEN ?? '',
  githubApiUrl: process.env.CLOUDNSITE_E2E_GITHUB_API_URL?.trim() || GITHUB_API_DEFAULT,
  storageState: process.env.CLOUDNSITE_E2E_STORAGE_STATE?.trim() ?? '',
};

const REQUIRED_INPUTS = [
  'CLOUDNSITE_E2E_HUB_URL',
  'CLOUDNSITE_E2E_TARGET_REPO',
  'CLOUDNSITE_E2E_TARGET_BRANCH',
  'CLOUDNSITE_E2E_GITHUB_TOKEN',
] as const;

const configured = Boolean(
  rawEnv.hubUrl &&
  (rawEnv.storageState || (rawEnv.email && rawEnv.password)) &&
  rawEnv.targetRepo &&
  rawEnv.targetBranch &&
  rawEnv.queueProjectId &&
  rawEnv.githubToken,
);

interface Config {
  hubUrl: string;
  email: string;
  password: string;
  contentRepo: string;
  contentBranch: string;
  contentRepoSlug: string;
  targetRepo: string;
  targetBranch: string;
  queueProjectId: string;
  githubToken: string;
  githubApiUrl: string;
  storageState: string;
}

interface ContentProjectResult {
  url: string;
  branch: string;
  content_project_id: string;
  folder_id: string;
  path: string;
  scope: string;
  status: string;
}

interface InstallResult {
  target_project_id: string;
  content_projects: ContentProjectResult[];
  status: string;
  failed: unknown[];
  helpdesk_id: string;
  journey_ids: string[];
  skill_ids: string[];
  auto_launch_journey_id: string;
}

interface SetupData {
  project: { id: string };
  install_preparation: {
    branch: string;
    status: string;
    pushed: boolean;
  };
  install_result: InstallResult;
}

interface ApiEnvelope<T> {
  status: string;
  data: T;
}

interface RepoAccessSummary {
  full_name?: string;
  role?: 'admin' | 'write' | 'read';
}

interface RepoAccessPage {
  repos?: RepoAccessSummary[];
  next_page?: number | null;
  page?: number;
}

interface GitHubRepository {
  full_name?: string;
  private?: boolean;
  default_branch?: string;
}

interface GitHubCommit {
  sha?: string;
  commit?: { message?: string };
  parents?: Array<{ sha?: string }>;
  files?: Array<{ filename?: string; previous_filename?: string; status?: string }>;
}

interface GitHubManifest {
  raw: string;
  json: Record<string, unknown>;
}

interface RunResult {
  workspace: Page;
  nodeId: string;
  providerId: string;
  setup: SetupData;
  consoleSecretLeak: () => boolean;
}

interface CleanupTarget {
  config: Config;
  nodeId: string;
  providerId?: string;
  workspace?: Page;
  conversationId?: string;
}

function logPhase(phase: string): void {
  console.log(`CloudNSite E2E phase: ${phase}`);
}

interface GitHubContent {
  content?: string;
  encoding?: string;
}

function githubRepoSlug(value: string): string | null {
  const trimmed = value.trim();
  const scp = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    const parts = url.pathname
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.git$/i, '')
      .split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return `${parts[0]}/${parts[1]}`.toLowerCase();
  } catch {
    return REPO_SLUG.test(trimmed) ? trimmed.replace(/\.git$/i, '').toLowerCase() : null;
  }
}

function loadConfig(): Config {
  const problems: string[] = [];
  let hubUrl = '';
  let githubApiUrl = '';

  try {
    const parsed = new URL(rawEnv.hubUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      problems.push('CLOUDNSITE_E2E_HUB_URL must be an HTTP(S) origin without credentials');
    } else if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      problems.push('CLOUDNSITE_E2E_HUB_URL must be an origin, not a path or query');
    } else {
      hubUrl = parsed.origin;
    }
  } catch {
    problems.push('CLOUDNSITE_E2E_HUB_URL must be a valid URL');
  }

  try {
    const parsed = new URL(rawEnv.githubApiUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      problems.push('CLOUDNSITE_E2E_GITHUB_API_URL must be an HTTPS URL without credentials or query data');
    } else {
      githubApiUrl = parsed.toString().replace(/\/$/, '');
    }
  } catch {
    problems.push('CLOUDNSITE_E2E_GITHUB_API_URL must be a valid URL');
  }

  const contentRepoSlug = githubRepoSlug(rawEnv.contentRepo);
  if (!contentRepoSlug) problems.push('CLOUDNSITE_E2E_CONTENT_REPO must identify one github.com owner/name repository');
  if (!REPO_SLUG.test(rawEnv.targetRepo)) problems.push('CLOUDNSITE_E2E_TARGET_REPO must be exactly owner/name');
  if (!SAFE_BRANCH.test(rawEnv.targetBranch) || rawEnv.targetBranch.endsWith('/')) {
    problems.push('CLOUDNSITE_E2E_TARGET_BRANCH is not a safe branch name');
  }
  if (rawEnv.targetBranch === REVIEW_BRANCH) {
    problems.push('CLOUDNSITE_E2E_TARGET_BRANCH must not be the Flowpad review branch');
  }
  if (!SAFE_BRANCH.test(rawEnv.contentBranch) || rawEnv.contentBranch.endsWith('/')) {
    problems.push('CLOUDNSITE_E2E_CONTENT_BRANCH is not a safe branch name');
  }
  if (!UUID_V4_OR_V5.test(rawEnv.queueProjectId)) {
    problems.push('CLOUDNSITE_E2E_QUEUE_PROJECT_ID must be a UUID v4 or v5');
  }
  if (hubUrl.endsWith('.flowpad.ai') && !rawEnv.storageState) {
    problems.push('CLOUDNSITE_E2E_STORAGE_STATE is required for an Auth0 Hub');
  }
  if (!rawEnv.storageState && (!rawEnv.email || !rawEnv.password)) {
    problems.push('provide CLOUDNSITE_E2E_STORAGE_STATE or local Hub email and password');
  }
  if (problems.length) throw new Error(`CloudNSite E2E preflight failed: ${problems.join('; ')}`);

  return {
    ...rawEnv,
    hubUrl,
    githubApiUrl,
    contentRepoSlug: contentRepoSlug!,
  };
}

function expectEntityId(value: unknown, label: string): asserts value is string {
  expect(typeof value, `${label} is a string`).toBe('string');
  expect(value, `${label} follows the UUID v4/v5 entity-id policy`).toMatch(UUID_V4_OR_V5);
}

function record(value: unknown, label: string): Record<string, unknown> {
  expect(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} is an object`).toBe(true);
  return value as Record<string, unknown>;
}

function assertKnownSecretsAbsent(config: Config, label: string, value: unknown): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  const leaked = [config.githubToken, config.password].filter(Boolean).some((secret) => serialized.includes(secret));
  expect(leaked, `${label} must not contain a known secret`).toBe(false);
}

function sensitiveKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => sensitiveKeys(item, `${prefix}[${index}]`));
  return Object.entries(value).flatMap(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const here = /(token|password|authorization|credential)/i.test(key) ? [path] : [];
    return [...here, ...sensitiveKeys(item, path)];
  });
}

function installUrl(config: Config): string {
  const url = new URL('/install', config.hubUrl);
  url.search = new URLSearchParams({
    content_repo: config.contentRepo,
    content_branch: config.contentBranch,
    name: INSTALL_NAME,
  }).toString();
  return url.toString();
}

function setupResponsePredicate(response: { url(): string; request(): { method(): string } }): boolean {
  return (
    response.request().method() === 'POST' &&
    /\/api\/v1\/graph\/compute_node\/[^/]+\/ops\/setup-git$/.test(new URL(response.url()).pathname)
  );
}

function nodeIdFromSetupUrl(url: string): string {
  const match = /\/compute_node\/([^/]+)\/ops\/setup-git$/.exec(new URL(url).pathname);
  expect(match, 'setup-git URL identifies the exact workspace node').toBeTruthy();
  expectEntityId(match![1], 'workspace node id');
  return match![1];
}

async function authenticate(context: BrowserContext, config: Config): Promise<void> {
  if (config.storageState) return;
  // Keep the password out of Playwright's browser/request tracing. Node makes
  // the credential exchange, then the browser receives only the resulting
  // session cookie (the same state an interactive login would establish).
  const response = await fetch(`${config.hubUrl}/api/v1/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: config.email, password: config.password }),
    redirect: 'error',
  });
  expect(response.status, 'Hub login succeeds').toBe(200);
  const setCookie = response.headers.get('set-cookie');
  expect(setCookie, 'Hub login establishes a session cookie').toBeTruthy();
  const cookiePair = setCookie!.split(';', 1)[0];
  const separator = cookiePair.indexOf('=');
  expect(separator, 'Hub session cookie has a name and value').toBeGreaterThan(0);
  await context.addCookies([
    {
      name: cookiePair.slice(0, separator),
      value: cookiePair.slice(separator + 1),
      url: config.hubUrl,
    },
  ]);
}

async function assertTargetRepoSelectable(context: BrowserContext, config: Config): Promise<void> {
  const repository = await githubJson<GitHubRepository>(config, `repos/${config.targetRepo}`);
  expect(repository.data?.full_name?.toLowerCase(), 'the verifier resolves the exact ephemeral repository').toBe(
    config.targetRepo.toLowerCase(),
  );
  expect(repository.data?.private, 'the ephemeral install target is private').toBe(true);
  expect(repository.data?.default_branch, 'the auto-initialized default branch is the selected base branch').toBe(
    config.targetBranch,
  );

  const baseSha = await githubRef(config, config.targetBranch);
  expect(baseSha, 'the ephemeral repository was auto-initialized').toBeTruthy();
  const initialCommit = await githubJson<GitHubCommit>(config, `repos/${config.targetRepo}/commits/${baseSha}`);
  expect(initialCommit.data?.sha).toBe(baseSha);
  expect(initialCommit.data?.parents, 'the selected base starts at the auto-initialized root commit').toHaveLength(0);

  const currentUserResponse = await context.request.get(`${config.hubUrl}/api/v1/current-user`);
  expect(currentUserResponse.status(), 'authenticated Flowpad user resolves before repository selection').toBe(200);
  const currentUserEnvelope = (await currentUserResponse.json()) as ApiEnvelope<{ id?: string }>;
  assertKnownSecretsAbsent(config, 'current-user response', currentUserEnvelope);
  expect(currentUserEnvelope.status, 'current-user returns SUCCESS').toBe('SUCCESS');
  expectEntityId(currentUserEnvelope.data?.id, 'authenticated Flowpad user id');

  const target = config.targetRepo.toLowerCase();
  let pageNumber = 1;
  let targetRepo: RepoAccessSummary | undefined;

  for (let pageCount = 0; pageCount < 50; pageCount += 1) {
    const repoResponse = await context.request.post(
      `${config.hubUrl}/api/v1/graph/user/${currentUserEnvelope.data.id}/repo/list`,
      { data: { provider: 'github', page: pageNumber } },
    );
    if (repoResponse.status() !== 200) {
      let failure: { detail?: unknown } | null = null;
      try {
        failure = (await repoResponse.json()) as { detail?: unknown };
      } catch {
        // Preserve the status-only diagnostic when Hub did not return JSON.
      }
      if (failure) assertKnownSecretsAbsent(config, 'repo list failure', failure);
      if (failure?.detail === 'GitHub not connected') {
        throw new Error(
          `CloudNSite E2E repo preflight failed: GitHub is not connected for the authenticated Flowpad account. ` +
            `Connect the CI GitHub identity before selecting ${config.targetRepo}.`,
        );
      }
      throw new Error(
        `CloudNSite E2E repo preflight failed: the authenticated Hub user cannot list GitHub repositories ` +
          `(HTTP ${repoResponse.status()}). Connect the CI GitHub identity before running the install gate.`,
      );
    }

    const envelope = (await repoResponse.json()) as Partial<ApiEnvelope<RepoAccessPage>>;
    assertKnownSecretsAbsent(config, 'repo list response', envelope);
    if (envelope.status !== 'SUCCESS' || !Array.isArray(envelope.data?.repos)) {
      throw new Error(
        `CloudNSite E2E repo preflight failed: the authenticated Hub user has no usable GitHub connection. ` +
          `Connect the CI GitHub identity before running the install gate.`,
      );
    }

    targetRepo = envelope.data.repos.find((repo) => repo.full_name?.toLowerCase() === target);
    if (targetRepo) break;

    const nextPage = envelope.data.next_page;
    if (typeof nextPage !== 'number' || nextPage <= pageNumber) break;
    pageNumber = nextPage;
  }

  if (!targetRepo) {
    throw new Error(
      `CloudNSite E2E repo preflight failed: ${config.targetRepo} is not visible to the authenticated Hub user. ` +
        `The temporary credential and ephemeral repository owner must be the same GitHub identity.`,
    );
  }
  if (targetRepo.role !== 'admin') {
    throw new Error(
      `CloudNSite E2E repo preflight failed: ${config.targetRepo} is ${targetRepo.role ?? 'not writable'} for the ` +
        `authenticated Hub user; the ephemeral repository owner must have admin access.`,
    );
  }
  logPhase('private ephemeral repository ownership verified');
}

async function runInstall(
  page: Page,
  context: BrowserContext,
  config: Config,
  onNodeCreated: (nodeId: string) => void,
): Promise<RunResult> {
  logPhase('open install link');
  let consoleSecretLeak = false;
  const watchConsole = (target: Page) => {
    target.on('console', (message) => {
      const text = message.text();
      if ([config.githubToken, config.password].filter(Boolean).some((secret) => text.includes(secret))) {
        consoleSecretLeak = true;
      }
    });
  };
  watchConsole(page);
  context.on('page', watchConsole);

  await authenticate(context, config);
  await assertTargetRepoSelectable(context, config);
  await page.goto(installUrl(config));

  const title = `Where do you want to install ${INSTALL_NAME}?`;
  const dialog = page.getByTestId('install-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('dialog', { name: title })).toBeVisible();
  await expect(dialog).toContainText(REVIEW_BRANCH);
  await expect(dialog).toContainText('default branch is not changed');
  await expect(dialog).toContainText('no pull request is opened automatically');
  logPhase('install dialog ready');

  await page.getByTestId(`repo-picker-row-${config.targetRepo}`).click();
  await page.getByTestId(`branch-picker-row-${config.targetBranch}`).click();

  const confirmation = page.getByTestId('install-confirmation');
  await expect(confirmation).toContainText(config.targetRepo);
  await expect(confirmation).toContainText(config.targetBranch);
  logPhase('target repository and branch selected');

  const popupPromise = context.waitForEvent('page');
  const nodeResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/api/v1/graph/compute_node'),
  );
  const setupResponsePromise = page.waitForResponse(setupResponsePredicate);
  await page.getByTestId('install-launch').click();
  logPhase('install launched');
  const workspace = await popupPromise;
  const nodeResponse = await nodeResponsePromise;
  expect(nodeResponse.status(), 'workspace node creation succeeds').toBe(200);
  const nodeEnvelope = (await nodeResponse.json()) as ApiEnvelope<{ id: string }>;
  assertKnownSecretsAbsent(config, 'workspace node creation response', nodeEnvelope);
  expect(nodeEnvelope.status).toBe('SUCCESS');
  expectEntityId(nodeEnvelope.data.id, 'created workspace node id');
  onNodeCreated(nodeEnvelope.data.id);
  logPhase('workspace node created');

  const setupResponse = await setupResponsePromise;
  const nodeId = nodeIdFromSetupUrl(setupResponse.url());
  expect(nodeId, 'setup-git runs on the workspace created by this test').toBe(nodeEnvelope.data.id);

  expect(new URL(setupResponse.url()).origin, 'setup-git stays on the configured Hub origin').toBe(config.hubUrl);
  expect(setupResponse.status(), 'setup-git succeeds').toBe(200);
  logPhase('setup-git response received');

  const setupRequest = setupResponse.request().postDataJSON() as unknown;
  assertKnownSecretsAbsent(config, 'setup-git URL', setupResponse.url());
  assertKnownSecretsAbsent(config, 'setup-git request', setupRequest);
  expect(sensitiveKeys(setupRequest), 'setup-git request has no secret-bearing fields').toEqual([]);

  const requestBody = record(setupRequest, 'setup-git request');
  const gitOrigin = record(requestBody.git_origin, 'setup-git git_origin');
  const install = record(requestBody.install, 'setup-git install');
  expect(`${String(gitOrigin.owner)}/${String(gitOrigin.name)}`.toLowerCase()).toBe(config.targetRepo.toLowerCase());
  expect(gitOrigin.branch).toBe(config.targetBranch);
  expect(install).toMatchObject({
    name: INSTALL_NAME,
    content_repo: config.contentRepo,
    content_branch: config.contentBranch,
    scope: 'shared',
    review_branch: REVIEW_BRANCH,
  });

  const envelope = (await setupResponse.json()) as ApiEnvelope<SetupData>;
  assertKnownSecretsAbsent(config, 'setup-git response', envelope);
  expect(envelope.status).toBe('SUCCESS');
  const setup = envelope.data;

  const nodeRead = await context.request.get(`${config.hubUrl}/api/v1/graph/compute_node/${nodeId}`);
  expect(nodeRead.status(), 'created workspace can be read for exact cleanup').toBe(200);
  const nodeReadEnvelope = (await nodeRead.json()) as ApiEnvelope<{ node_provider_id?: string }>;
  expect(nodeReadEnvelope.status).toBe('SUCCESS');
  expect(nodeReadEnvelope.data.node_provider_id, 'created workspace exposes its exact sandbox id').toBeTruthy();
  const providerId = nodeReadEnvelope.data.node_provider_id!;
  logPhase('workspace provider captured');

  await expect(page.getByTestId('install-progress')).toBeVisible();
  for (const step of ['launch', 'health', 'setup-git', 'open']) {
    await expect(page.getByTestId(`install-step-${step}`)).toHaveAttribute('data-status', 'success');
  }
  logPhase('install progress complete');

  await workspace.waitForURL((url) => url.pathname === `/dock/project/${setup.install_result.target_project_id}`);
  const landed = new URL(workspace.url());
  expect(landed.searchParams.get('journeyId')).toBe(setup.install_result.auto_launch_journey_id);
  logPhase('workspace opened on auto-launch journey');

  return { workspace, nodeId, providerId, setup, consoleSecretLeak: () => consoleSecretLeak };
}

function verifySetupContract(
  config: Config,
  setup: SetupData,
  expectedPreparation: 'installed' | 'already_installed',
): void {
  expectEntityId(setup.project.id, 'materialized Project id');
  expect(setup.install_preparation).toEqual({
    branch: REVIEW_BRANCH,
    status: expectedPreparation,
    pushed: expectedPreparation === 'installed',
  });

  const install = setup.install_result;
  expectEntityId(install.target_project_id, 'target Project id');
  expect(install.target_project_id).toBe(setup.project.id);
  expect(install.failed).toEqual([]);
  expect(['installed', 'already_installed']).toContain(install.status);
  expect(install.content_projects).toHaveLength(1);
  expect(install.journey_ids.length).toBeGreaterThan(0);
  expect(install.skill_ids.length).toBeGreaterThan(0);
  expectEntityId(install.helpdesk_id, 'Helpdesk id');
  expectEntityId(install.auto_launch_journey_id, 'auto-launch Journey id');
  expect(install.journey_ids).toContain(install.auto_launch_journey_id);

  for (const [index, id] of install.journey_ids.entries()) expectEntityId(id, `Journey id ${index}`);
  for (const [index, id] of install.skill_ids.entries()) expectEntityId(id, `Skill id ${index}`);

  const content = install.content_projects[0];
  expect(githubRepoSlug(content.url)).toBe(config.contentRepoSlug);
  expect(content.branch).toBe(config.contentBranch);
  expect(content.scope).toBe('shared');
  expect(['installed', 'already_installed']).toContain(content.status);
  expect(content.path).toBeTruthy();
  expectEntityId(content.content_project_id, 'content Project id');
  expectEntityId(content.folder_id, 'context Folder id');
}

async function workspaceGraph<T>(page: Page, path: string, body?: Record<string, unknown>): Promise<T> {
  const result = await page.evaluate(
    async ({ graphPath, graphBody }) => {
      const response = await fetch(`/api/v1/graph/${graphPath}`, {
        method: graphBody ? 'POST' : 'GET',
        headers: graphBody ? { 'content-type': 'application/json' } : undefined,
        body: graphBody ? JSON.stringify(graphBody) : undefined,
      });
      return { status: response.status, text: await response.text() };
    },
    { graphPath: path, graphBody: body },
  );
  expect(result.status, `workspace graph ${path} succeeds`).toBe(200);
  const envelope = JSON.parse(result.text) as ApiEnvelope<T>;
  expect(envelope.status, `workspace graph ${path} returns SUCCESS`).toBe('SUCCESS');
  return envelope.data;
}

async function verifyWorkspace(
  config: Config,
  result: RunResult,
  onTicketCreated: (conversationId: string) => void,
): Promise<void> {
  const { workspace, setup } = result;
  const install = setup.install_result;
  const content = install.content_projects[0];

  const tray = workspace.getByTestId('journey-tray');
  await expect(tray).toHaveAccessibleName(JOURNEY_NAME);
  await expect(workspace.getByTestId('journey-tray-steps-left')).toBeVisible();
  const welcome = workspace.getByTestId('html-preview');
  await expect(welcome).toBeVisible();
  await expect(
    workspace.frameLocator('[data-testid="html-preview"]').getByText('CloudNSite agents are ready.'),
  ).toBeVisible();
  logPhase('journey visible');

  const project = await workspaceGraph<{ include_dirs?: string[] }>(workspace, `project/${install.target_project_id}`);
  expect((project.include_dirs ?? []).filter((path) => path === content.path)).toHaveLength(1);
  await workspaceGraph(workspace, `folder/${content.folder_id}`);
  await workspaceGraph(workspace, `project/${content.content_project_id}`);

  const journey = await workspaceGraph<{ name?: string }>(workspace, `journey/${install.auto_launch_journey_id}`);
  expect(journey.name).toBe(JOURNEY_NAME);

  const skills = await Promise.all(
    install.skill_ids.map((id) => workspaceGraph<{ id: string; name?: string }>(workspace, `skill/${id}`)),
  );
  const triage = skills.find((skill) => skill.name === 'triage-ticket');
  expect(triage, 'triage-ticket is installed and resolves in the workspace').toBeTruthy();

  const helpdesk = await workspaceGraph<{ name?: string }>(workspace, `helpdesk/${install.helpdesk_id}`);
  expect(helpdesk.name).toBe('CloudNSite Support');

  const agents = await workspaceGraph<Array<{ name?: string }>>(
    workspace,
    `project/${content.content_project_id}/agent`,
  );
  expect(
    agents.some((agent) => agent.name === 'support'),
    'the CloudNSite support agent is available',
  ).toBe(true);
  logPhase('installed graph verified');

  const ensureResponsePromise = workspace.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/api/v1/graph/helpdesk-ensure'),
  );
  await workspace.getByTestId('footer-helpdesk-button').click();
  await expect(workspace.getByTestId('helpdesk-load-dialog')).toBeVisible();
  const ensureResponse = await ensureResponsePromise;
  expect(ensureResponse.status(), 'adopted Helpdesk setup succeeds').toBe(200);
  const ensure = (await ensureResponse.json()) as ApiEnvelope<{
    adopted?: boolean;
    helpdesk_project_id?: string;
    project_id?: string;
  }>;
  expect(ensure.status).toBe('SUCCESS');
  expect(ensure.data).toMatchObject({
    adopted: true,
    helpdesk_project_id: config.queueProjectId,
    project_id: content.content_project_id,
  });
  logPhase('helpdesk adopted');

  const ticketText = `[${RUN_MARKER}] verify CloudNSite install routing`;
  const ticket = await workspaceGraph<{ conversation_id: string; project_id: string }>(
    workspace,
    'helpdesk-start-ticket',
    { project_id: install.target_project_id, text: ticketText },
  );
  expectEntityId(ticket.conversation_id, 'synthetic support conversation id');
  expect(ticket.project_id).toBe(config.queueProjectId);
  onTicketCreated(ticket.conversation_id);
  logPhase('sample ticket created');

  const queue = await workspaceGraph<{
    project_id: string;
    tickets: Array<{ conversation_id?: string; preview?: string }>;
  }>(workspace, 'helpdesk-tickets-list', { project_id: install.target_project_id });
  expect(queue.project_id).toBe(config.queueProjectId);
  expect(
    queue.tickets.some((row) => row.conversation_id === ticket.conversation_id && row.preview?.includes(RUN_MARKER)),
    'CloudNSite staff queue exposes the uniquely marked ticket',
  ).toBe(true);
  logPhase('sample ticket routed');

  await workspace.waitForURL((url) => url.pathname === `/dock/helpdesk/${content.content_project_id}`);
  await expect(workspace.getByTestId('helpdesk-portal')).toBeVisible();
  await expect(workspace.getByTestId('helpdesk-brand-header')).toContainText('CloudNSite');
  await expect(workspace.getByTestId('helpdesk-guides')).toBeVisible();
  logPhase('branded helpdesk visible');

  const skillUrl = new URL(`/dock/assets/editor/skill/typeid/skill-${triage!.id}`, workspace.url());
  await workspace.goto(skillUrl.toString());
  await expect(workspace.getByTestId('asset-editor-header')).toBeVisible();
  await expect(workspace.getByTestId('asset-editor-header')).toContainText('triage-ticket');
  logPhase('sample skill visible');

  expect(result.consoleSecretLeak(), 'browser console output contains no known secret').toBe(false);
}

function githubEndpoint(config: Config, path: string): string {
  return `${config.githubApiUrl}/${path.replace(/^\//, '')}`;
}

async function githubJson<T>(
  config: Config,
  path: string,
  allowed: number[] = [200],
): Promise<{ status: number; data: T | null }> {
  const response = await fetch(githubEndpoint(config, path), {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${config.githubToken}`,
      'user-agent': 'flowpad-cloudnsite-e2e',
      'x-github-api-version': '2022-11-28',
    },
    redirect: 'error',
  });
  expect(allowed, `GitHub verifier returned an allowed status for ${path}`).toContain(response.status);
  if (response.status === 204 || response.status === 404) return { status: response.status, data: null };
  return { status: response.status, data: (await response.json()) as T };
}

async function githubRef(config: Config, branch: string): Promise<string | null> {
  const result = await githubJson<{ object?: { sha?: string } }>(
    config,
    `repos/${config.targetRepo}/git/ref/heads/${encodeURIComponent(branch)}`,
    [200, 404],
  );
  if (result.status === 404) return null;
  const sha = result.data?.object?.sha;
  expect(sha, `GitHub ref ${branch} has a commit SHA`).toMatch(/^[0-9a-f]{40}$/i);
  return sha!;
}

async function githubManifest(config: Config, ref: string): Promise<GitHubManifest | null> {
  const result = await githubJson<GitHubContent>(
    config,
    `repos/${config.targetRepo}/contents/.flowpad/bootstrap.json?ref=${encodeURIComponent(ref)}`,
    [200, 404],
  );
  if (result.status === 404) return null;
  expect(result.data?.encoding).toBe('base64');
  expect(typeof result.data?.content).toBe('string');
  const raw = Buffer.from(result.data!.content!.replace(/\s/g, ''), 'base64').toString('utf8');
  return { raw, json: record(JSON.parse(raw) as unknown, '.flowpad/bootstrap.json') };
}

function requireManifest(manifest: GitHubManifest | null, label: string): GitHubManifest {
  expect(manifest, label).not.toBeNull();
  return manifest!;
}

function contentEntries(manifest: Record<string, unknown>): Record<string, unknown>[] {
  const entries = manifest.content_projects;
  expect(entries === undefined || Array.isArray(entries), 'content_projects is an array when present').toBe(true);
  return (entries ?? []).map((entry, index) => record(entry, `content_projects[${index}]`));
}

function nonContentFields(manifest: Record<string, unknown>): Record<string, unknown> {
  const fields = { ...manifest };
  delete fields.content_projects;
  return fields;
}

function verifyReviewManifest(config: Config, base: Record<string, unknown>, review: Record<string, unknown>): void {
  const isCloudNsite = (entry: Record<string, unknown>) =>
    typeof entry.url === 'string' && githubRepoSlug(entry.url) === config.contentRepoSlug;
  const baseEntries = contentEntries(base);
  const reviewEntries = contentEntries(review);
  const installed = reviewEntries.filter(isCloudNsite);

  expect(installed).toHaveLength(1);
  expect(installed[0]).toMatchObject({ branch: config.contentBranch, scope: 'shared' });
  expect(reviewEntries.filter((entry) => !isCloudNsite(entry))).toEqual(
    baseEntries.filter((entry) => !isCloudNsite(entry)),
  );
  expect(nonContentFields(review)).toEqual(nonContentFields(base));
}

async function verifyReviewCommit(config: Config, baseSha: string, reviewSha: string): Promise<void> {
  const commit = await githubJson<GitHubCommit>(config, `repos/${config.targetRepo}/commits/${reviewSha}`);
  expect(commit.data?.sha, 'the review ref resolves to the verified install commit').toBe(reviewSha);
  expect(commit.data?.commit?.message?.split(/\r?\n/, 1)[0]).toBe('chore(flowpad): install CloudNSite agents');
  expect(
    commit.data?.parents?.map((parent) => parent.sha),
    'the install commit is based directly on the unchanged auto-init commit',
  ).toEqual([baseSha]);
  expect(
    commit.data?.files?.map(({ filename, previous_filename, status }) => ({
      filename,
      previous_filename,
      status,
    })),
    'the install commit only adds the review manifest',
  ).toEqual([{ filename: '.flowpad/bootstrap.json', previous_filename: undefined, status: 'added' }]);

  const [owner] = config.targetRepo.split('/');
  const pulls = await githubJson<unknown[]>(
    config,
    `repos/${config.targetRepo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${REVIEW_BRANCH}`)}`,
  );
  expect(pulls.data, 'the install flow does not open a pull request').toEqual([]);
}

async function cleanupWorkspace(context: BrowserContext, target: CleanupTarget): Promise<void> {
  const { config, nodeId, providerId, workspace, conversationId } = target;
  const failures: unknown[] = [];
  const attempt = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };

  if (conversationId) {
    await attempt(async () => {
      expect(workspace && !workspace.isClosed(), 'ticket cleanup still has its exact workspace page').toBe(true);
      await workspaceGraph(workspace!, 'conversation-delete', {
        conversation_id: conversationId,
        mode: 'delete_for_all',
      });
    });
  }

  const base = `${config.hubUrl}/api/v1/graph/compute_node/${nodeId}`;
  if (providerId) {
    await attempt(async () => {
      const before = await context.request.get(base);
      expect(before.status(), 'captured workspace still resolves before cleanup').toBe(200);
      const envelope = (await before.json()) as ApiEnvelope<{ node_provider_id?: string }>;
      expect(envelope.data.node_provider_id, 'cleanup targets the captured sandbox only').toBe(providerId);
    });
  }
  await attempt(async () => {
    const shutdown = await context.request.post(`${base}/ops/shutdown`, { data: {} });
    expect(shutdown.status(), 'the exact test workspace shuts down').toBe(200);
  });
  await attempt(async () => {
    const remove = await context.request.delete(base);
    expect(remove.status(), 'the exact test workspace entity is deleted').toBe(200);
  });
  await attempt(async () => {
    const list = await context.request.get(`${config.hubUrl}/api/v1/graph/compute_node`);
    expect(list.status(), 'Hub desktop list is readable after cleanup').toBe(200);
    const envelope = (await list.json()) as ApiEnvelope<Array<{ id?: string }>>;
    expect(envelope.status).toBe('SUCCESS');
    expect(
      envelope.data.some((node) => node.id === nodeId),
      'deleted workspace is absent from Hub',
    ).toBe(false);
  });

  if (failures.length) throw new AggregateError(failures, `CloudNSite workspace cleanup failed for ${nodeId}`);
}

test.describe.serial('CloudNSite install link — live Hub and E2B release gate', () => {
  test.use(rawEnv.storageState ? { storageState: rawEnv.storageState } : {});
  test.skip(
    !configured,
    `opt-in: set ${REQUIRED_INPUTS.join(', ')} and either CLOUDNSITE_E2E_STORAGE_STATE or local Hub credentials`,
  );

  let cleanup: CleanupTarget | null = null;

  test.afterEach(async ({ context }) => {
    if (!cleanup) return;
    await cleanupWorkspace(context, cleanup);
    cleanup = null;
  });

  test('clean install creates a review branch and opens the complete CloudNSite experience', async ({
    page,
    context,
  }) => {
    const config = loadConfig();
    logPhase('clean scenario started');
    const baseBefore = await githubRef(config, config.targetBranch);
    expect(baseBefore, 'the selected target base branch exists').toBeTruthy();
    expect(await githubRef(config, REVIEW_BRANCH), 'the fresh target has no review branch').toBeNull();
    const baseManifestBefore = await githubManifest(config, config.targetBranch);
    expect(baseManifestBefore, 'the fresh auto-init branch has no Flowpad manifest').toBeNull();

    const result = await runInstall(page, context, config, (nodeId) => {
      cleanup = { config, nodeId };
    });
    logPhase('clean install returned');
    cleanup = { config, nodeId: result.nodeId, providerId: result.providerId, workspace: result.workspace };
    verifySetupContract(config, result.setup, 'installed');
    expect(result.setup.install_result.status).toBe('installed');
    expect(result.setup.install_result.content_projects[0].status).toBe('installed');
    await verifyWorkspace(config, result, (conversationId) => {
      cleanup = { ...cleanup!, conversationId };
    });
    logPhase('clean workspace verified');

    const baseAfter = await githubRef(config, config.targetBranch);
    const reviewAfter = await githubRef(config, REVIEW_BRANCH);
    expect(baseAfter, 'the install never changes the selected base ref').toBe(baseBefore);
    expect(reviewAfter, 'the install creates the fixed review ref').toBeTruthy();
    const baseManifestAfter = await githubManifest(config, config.targetBranch);
    expect(baseManifestAfter, 'the selected base still has no Flowpad manifest').toBeNull();
    const reviewManifest = requireManifest(
      await githubManifest(config, REVIEW_BRANCH),
      'the review branch contains the installed Flowpad manifest',
    );
    verifyReviewManifest(config, {}, reviewManifest.json);
    await verifyReviewCommit(config, baseBefore!, reviewAfter!);
    logPhase('clean GitHub result verified');
  });

  test('repeat install reuses the review branch without another commit or duplicate context', async ({
    page,
    context,
  }) => {
    const config = loadConfig();
    logPhase('repeat scenario started');
    const baseBefore = await githubRef(config, config.targetBranch);
    const reviewBefore = await githubRef(config, REVIEW_BRANCH);
    expect(baseBefore, 'the selected target base branch exists').toBeTruthy();
    expect(reviewBefore, 'the repeat case starts from the clean case review branch').toBeTruthy();
    const baseManifestBefore = await githubManifest(config, config.targetBranch);
    expect(baseManifestBefore, 'the repeat case starts with no manifest on the selected base').toBeNull();
    const reviewManifestBefore = requireManifest(
      await githubManifest(config, REVIEW_BRANCH),
      'the repeat case starts with the installed review manifest',
    );

    const result = await runInstall(page, context, config, (nodeId) => {
      cleanup = { config, nodeId };
    });
    logPhase('repeat install returned');
    cleanup = { config, nodeId: result.nodeId, providerId: result.providerId, workspace: result.workspace };
    verifySetupContract(config, result.setup, 'already_installed');
    await verifyWorkspace(config, result, (conversationId) => {
      cleanup = { ...cleanup!, conversationId };
    });
    logPhase('repeat workspace verified');

    const baseAfter = await githubRef(config, config.targetBranch);
    const reviewAfter = await githubRef(config, REVIEW_BRANCH);
    expect(baseAfter, 'repeat install leaves the selected base ref unchanged').toBe(baseBefore);
    expect(reviewAfter, 'repeat install creates no new review commit').toBe(reviewBefore);
    const baseManifestAfter = await githubManifest(config, config.targetBranch);
    const reviewManifestAfter = requireManifest(
      await githubManifest(config, REVIEW_BRANCH),
      'the repeat case keeps the installed review manifest',
    );
    expect(baseManifestAfter, 'repeat install leaves the base manifest absent').toBeNull();
    expect(reviewManifestAfter.raw, 'repeat install leaves the review manifest unchanged').toBe(
      reviewManifestBefore.raw,
    );
    verifyReviewManifest(config, {}, reviewManifestAfter.json);
    await verifyReviewCommit(config, baseBefore!, reviewAfter!);
    logPhase('repeat GitHub result verified');
  });
});

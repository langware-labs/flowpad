/**
 * Source-level guard for the live hub tier.
 *
 * Hub tests mutate real backends and exercise two identities. Keep them bound
 * to the caller-owned cycle instances and credentials; stale env files,
 * developer-instance fallbacks, and runner-side service launches must never be
 * able to redirect a QA cycle.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const hubSource = (name: string) => readFileSync(resolve(__dirname, `../hub/${name}`), 'utf8');
const repoSource = (name: string) => readFileSync(resolve(__dirname, `../../../${name}`), 'utf8');

const INSTANCES = hubSource('_instances.ts');
const HUB_HELPERS = hubSource('_hub.ts');
const HUB_CONFIG = hubSource('vitest.config.ts');
const HUB_SETUP = hubSource('_setup.ts');
const BROWSER_HELPERS = hubSource('_browser.ts');
const SHARE_MATRIX = hubSource('share_matrix.ui.test.ts');
const ASSET_SHARE_MATRIX = hubSource('asset_share_index_matrix.test.ts');
const GROUP_TASK_ATTACHMENTS = hubSource('group_task_attachments_two_client.test.ts');
const PLAN_SHARE = hubSource('plan_share.test.ts');
const SKILL_RUN_VIBE = hubSource('skill_run_vibe_mcp_ui.ui.test.ts');
const SPORA_SETUP_VIBE = hubSource('spora_setup_vibe.ui.test.ts');
const TRANSCRIPT_SHARE = hubSource('transcript_share_two_client.test.ts');
const MATRIX_BOB = hubSource('matrix.bob.test.ts');
const PING_PONG_BOB = hubSource('conversation_messages.bob.test.ts');
const RENAME_BOB = hubSource('rename.bob.test.ts');
const PAIRED_HELPERS = hubSource('_matrix.ts');
const ROOT_CONFIG = repoSource('ui/vitest.config.ts');
const PAIRED_RUNNER = repoSource('scripts/run_hub_paired.sh');
const INBOX_VIEW = repoSource('ui/src/components/inbox-view/InboxView.tsx');

const TWO_INSTANCE_FILES = [
  'asset_share_index_matrix.test.ts',
  'helpdesk_two_client.test.ts',
  'doc_comment_sync.test.ts',
  'git_artifact_bookmark_two_client.test.ts',
  'group_task_attachments_two_client.test.ts',
  'member_role_change.test.ts',
  'plan_share.test.ts',
  'share_matrix.ui.test.ts',
  'skill_run_vibe_mcp_ui.ui.test.ts',
  'skill_share_two_client.test.ts',
  'spora_setup_vibe.ui.test.ts',
  'transcript_share_two_client.test.ts',
] as const;

describe('hub launched-instance isolation source policy', () => {
  it('resolves only canonical pair identities through generated env + live launcher PIDs', () => {
    expect(INSTANCES).toContain("process.env.SHARE_INST_1?.trim() || ''");
    expect(INSTANCES).toContain("process.env.SHARE_INST_2?.trim() || ''");
    expect(INSTANCES).toContain('process.env.ALICE_EMAIL');
    expect(INSTANCES).toContain('process.env.ALICE_PW');
    expect(INSTANCES).toContain('process.env.BOB_EMAIL');
    expect(INSTANCES).toContain('process.env.BOB_PW');
    expect(INSTANCES).toContain('env.FLOW_INSTANCE !== name');
    expect(INSTANCES).toContain("path.join(flowHome, 'instances', name, 'launcher.json')");
    expect(INSTANCES).toContain('launcher.name !== name');
    expect(INSTANCES).toContain('Number(launcher.backend_port) !== Number(backendPort)');
    expect(INSTANCES).toContain('Number(launcher.frontend_port) !== Number(frontendPort)');
    expect(INSTANCES).toContain('!pidIsLive(launcher.backend_pid)');
    expect(INSTANCES).toContain('!pidIsLive(launcher.frontend_pid)');
    expect(INSTANCES).toContain('process.kill(pid, 0)');
    expect(INSTANCES).toContain('export function instanceAvailable(name: string): boolean');
    expect(INSTANCES).not.toContain('promises as fs');
    expect(INSTANCES).not.toMatch(/\|\|\s*['"](?:dev-1|dev-2|bobqa)['"]/);
  });

  it('binds the hub SDK config and setup gate to FLOW_INSTANCE and the selected pair', () => {
    expect(HUB_CONFIG).toContain("const instanceName = process.env.FLOW_INSTANCE?.trim() || '';");
    expect(HUB_CONFIG).toContain("const mode = instanceName || 'test';");
    expect(HUB_CONFIG).toContain('env.FLOW_INSTANCE === instanceName');
    expect(HUB_CONFIG).toContain("viteConfig({ mode, command: 'serve' }");
    expect(HUB_CONFIG).toContain('__HUB_INSTANCE_NAME__: JSON.stringify(instanceName)');
    expect(HUB_CONFIG).not.toContain("loadEnv('test'");

    expect(HUB_SETUP).toContain("const selectedInstance = process.env.FLOW_INSTANCE?.trim() || '';");
    expect(HUB_SETUP).toContain('![HUB_INST_1, HUB_INST_2].includes(selectedInstance)');
    expect(HUB_SETUP).toContain('resolveLaunchedInstance(HUB_INST_1)');
    expect(HUB_SETUP).toContain('resolveLaunchedInstance(HUB_INST_2)');
    expect(HUB_SETUP).toContain('!launched1 ||');
    expect(HUB_SETUP).toContain('!launched2 ||');
    expect(HUB_SETUP).toContain('__HUB_BACKEND_PORT__ !== selectedPort');
    expect(HUB_SETUP).toContain('ALICE_EMAIL/ALICE_PW and BOB_EMAIL/BOB_PW');
  });

  it.each(TWO_INSTANCE_FILES)('%s selects both canonical share instances with no named fallback', (name) => {
    const source = hubSource(name);
    expect(source).toContain('HUB_INST_1');
    expect(source).toContain('HUB_INST_2');
    expect(source).not.toMatch(/process\.env\.(?:SHARE_INST|MATRIX_INST)/);
    expect(source).not.toMatch(/getInstance\(['"](?:dev-1|dev-2|bobqa)['"]\)/);
    expect(source).not.toMatch(/instanceAvailable\(['"](?:dev-1|dev-2|bobqa)['"]\)/);
    expect(source).not.toMatch(/\|\|\s*['"](?:dev-1|dev-2|bobqa)['"]/);
  });

  it('selects the one-backend browser stress instance from the same canonical pair', () => {
    const source = hubSource('chat_terminal_switch_stress.ui.test.ts');
    expect(source).toContain('HUB_INST_1 as INSTANCE');
    expect(source).not.toContain("const INSTANCE = 'dev-1'");
    expect(source).not.toMatch(/getInstance\(['"]dev-1['"]\)/);
  });

  it('discovers exact invitations through the lightweight pending-only sync', () => {
    const helperStart = INSTANCES.indexOf('export async function findPendingInvitation(');
    const helper = INSTANCES.slice(helperStart);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helper).toContain('/api/v1/graph/invitation-sync');
    expect(helper).toContain('JSON.stringify({ conversation_id: convId })');
    expect(helper).toContain("body?.status !== 'SUCCESS'");
    expect(helper).not.toContain('await inst.sdk.fetchConversations()');
  });

  it('keeps the staged asset matrix target-specific after invitation accept', () => {
    const helperStart = ASSET_SHARE_MATRIX.indexOf('async function acceptAndFindMessage(');
    const helperEnd = ASSET_SHARE_MATRIX.indexOf("describe('asset share", helperStart);
    const helper = ASSET_SHARE_MATRIX.slice(helperStart, helperEnd);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(helper).toContain('/graph/conversation-message-sync');
    expect(helper).toContain('conversation_id: convId');
    expect(helper).not.toContain('bob.sdk.fetchConversations()');
    expect(ASSET_SHARE_MATRIX).toContain('const createdConversations:');
    expect(ASSET_SHARE_MATRIX).toContain('const createdAssets:');
    expect(ASSET_SHARE_MATRIX).toContain('/graph/conversation/${conversation.id}');
    expect(ASSET_SHARE_MATRIX).toContain('/fs-records/${asset.type}/${asset.id}');
    expect(ASSET_SHARE_MATRIX).not.toContain('const SWEEP_TYPES');
    expect(ASSET_SHARE_MATRIX).not.toContain("label.startsWith('e2etest-')");
  });

  it('keeps group-task invitation discovery child-aware and pending-only', () => {
    expect(GROUP_TASK_ATTACHMENTS).toContain('created?.data?.children');
    expect(GROUP_TASK_ATTACHMENTS).toContain("'/graph/invitation-sync'");
    expect(GROUP_TASK_ATTACHMENTS).toContain('[task.id, ...memberTaskIds]');
    expect(GROUP_TASK_ATTACHMENTS).not.toContain('bob.sdk.fetchConversations()');
  });

  it('keeps plan cleanup exact instead of sweeping the long-lived receiver', () => {
    expect(PLAN_SHARE).toContain('const createdEntities:');
    expect(PLAN_SHARE).toContain('const createdConversations:');
    expect(PLAN_SHARE).toContain('/graph/${entity.type}/${entity.id}');
    expect(PLAN_SHARE).toContain('/graph/conversation/${conversation.id}');
    expect(PLAN_SHARE).toContain('/graph/conversation-message-sync');
    expect(PLAN_SHARE).toContain('conversation_id: convId');
    expect(PLAN_SHARE).not.toContain('bob.sdk.fetchConversations()');
    expect(PLAN_SHARE).not.toContain('const SWEEP_TYPES');
    expect(PLAN_SHARE).not.toContain("label.startsWith('e2etest-')");
  });

  it('accepts both valid received-skill entry surfaces within the existing action window', () => {
    expect(SKILL_RUN_VIBE).toContain('const firstSurface = await Promise.race([');
    expect(SKILL_RUN_VIBE).toContain("then(() => 'download' as const)");
    expect(SKILL_RUN_VIBE).toContain("then(() => 'staged' as const)");
    expect(SKILL_RUN_VIBE).toContain("if (firstSurface === 'download')");
  });

  it('asserts the first-class app frame after flow app open', () => {
    expect(SPORA_SETUP_VIBE).toContain("'app',");
    expect(SPORA_SETUP_VIBE).toContain("'open',");
    expect(SPORA_SETUP_VIBE).toContain('iframe[data-testid="vibe-app-frame"]');
    expect(SPORA_SETUP_VIBE).not.toContain('iframe[data-testid="vibe-webapp-frame"]');
    expect(SPORA_SETUP_VIBE).toContain('/api/v1/graph/project/${project.id}');
    expect(SPORA_SETUP_VIBE).toContain('/graph/conversation-message-sync');
    expect(SPORA_SETUP_VIBE).toContain('conversation_id: convId');
    expect(SPORA_SETUP_VIBE).not.toContain('bob.sdk.fetchConversations()');
    expect(SPORA_SETUP_VIBE).toContain('const createdConversations:');
    expect(SPORA_SETUP_VIBE).toContain('const createdArtifacts:');
    expect(SPORA_SETUP_VIBE).toContain('const createdProcesses:');
    expect(SPORA_SETUP_VIBE).toContain('const createdAttachments:');
    expect(SPORA_SETUP_VIBE).toContain('/graph/agentic_process/${createdProcess.id}/close');
    expect(SPORA_SETUP_VIBE).toContain('/graph/message_attachment/${attachment.id}');
    expect(SPORA_SETUP_VIBE).toContain('/fs-records/artifact/${artifact.id}');
  });

  it('reads hub credentials only from the cycle environment', () => {
    expect(HUB_HELPERS).toContain('process.env.ALICE_EMAIL');
    expect(HUB_HELPERS).toContain('process.env.ALICE_PW');
    expect(HUB_HELPERS).toContain('process.env.BOB_EMAIL');
    expect(HUB_HELPERS).toContain('process.env.BOB_PW');
    expect(HUB_HELPERS).not.toContain('readEnvLocal');
    expect(HUB_HELPERS).not.toContain("'.env.local'");
    expect(HUB_HELPERS).not.toContain('flowpad-app');

    const aliceRename = hubSource('rename.alice.test.ts');
    const bobRename = hubSource('rename.bob.test.ts');
    expect(aliceRename).toContain('process.env.ALICE_EMAIL');
    expect(aliceRename).toContain('process.env.ALICE_PW');
    expect(aliceRename).toContain('process.env.BOB_EMAIL');
    expect(bobRename).toContain('process.env.BOB_EMAIL');
    expect(bobRename).toContain('process.env.BOB_PW');
    expect(aliceRename + bobRename).not.toContain('RENAME_');
  });

  it('classifies all six protocol halves as paired-only', () => {
    for (const file of [
      'matrix.alice.test.ts',
      'matrix.bob.test.ts',
      'conversation_messages.test.ts',
      'conversation_messages.bob.test.ts',
      'rename.alice.test.ts',
      'rename.bob.test.ts',
    ]) {
      expect(ROOT_CONFIG.match(new RegExp(file.replaceAll('.', '\\.'), 'g'))).toHaveLength(2);
    }
  });

  it('keeps paired invitation discovery target-specific on long-lived accounts', () => {
    expect(PAIRED_HELPERS).toContain('/graph/invitation-sync');
    expect(PAIRED_HELPERS).toContain('JSON.stringify({ conversation_id: convId })');
    expect(PAIRED_HELPERS).toContain("body?.status !== 'SUCCESS'");
    for (const source of [MATRIX_BOB, PING_PONG_BOB, RENAME_BOB]) {
      expect(source).toContain('syncPendingInvitation(config.SERVER_URL, convId)');
      expect(source).toContain('pickPendingInvitation(all, convId)');
      expect(source).not.toContain('fetchConversations');
    }
  });

  it('keeps the helpdesk staff path failing loudly when authorization is absent', () => {
    const source = hubSource('helpdesk_two_client.test.ts');
    expect(source).toContain('getAliceCreds');
    expect(source).toContain('getBobCreds');
    expect(source).toContain('hubLogin(guest.email, guestPassword)');
    expect(source).toContain('hubLogin(staff.email, staffPassword)');
    expect(source).toContain(
      "throw new Error(\n        `[help desk test] staff '${staff.email}' cannot read the help desk queue;",
    );
    expect(source).not.toContain('`${staff.name}-pw-1234`');
  });

  it('keeps multi-step share fixtures under file-level two-realm cleanup', () => {
    // The matrix carries workflow/conversation ids from A1 through A4. The
    // shared registry purges after every `it`, so registering those fixtures
    // there destroys the scenario before the receiver can accept or download.
    expect(SHARE_MATRIX).toContain("import { testEntityName } from '../_cleanup';");
    expect(SHARE_MATRIX).not.toContain('trackForCleanup');
    expect(SHARE_MATRIX).not.toContain('trackTypeId');
    expect(SHARE_MATRIX).toContain("'dynamic_workflow',");
    expect(SHARE_MATRIX).toContain("this file's two-realm afterAll owns them");
    expect(SHARE_MATRIX).toContain('ownedTestEntityName');
    expect(SHARE_MATRIX).toContain('ownedConversationTitles.has');
    expect(SHARE_MATRIX).not.toContain('/api/v1/graph/conversation-list');
    expect(SHARE_MATRIX).not.toContain('await conv.share([dev2.email])');
    expect(SHARE_MATRIX).toContain('/graph/compute_node/@local/fs-records/${type}/${r.id}');
  });

  it('finishes the invitation-accept request before the matrix reuses the receiver page', () => {
    const homeClick = BROWSER_HELPERS.indexOf(`page.locator('[data-rail-item="home"]').click()`);
    const targetedSync = BROWSER_HELPERS.indexOf('/api/v1/graph/invitation-sync');
    const inboxClick = BROWSER_HELPERS.indexOf(`page.locator('[data-rail-item="inbox"]').click()`);
    expect(homeClick).toBeGreaterThan(-1);
    expect(targetedSync).toBeGreaterThan(homeClick);
    expect(inboxClick).toBeGreaterThan(targetedSync);
    expect(BROWSER_HELPERS).toContain(`page.locator('[data-rail-item="inbox"]').click()`);
    expect(BROWSER_HELPERS).toContain('JSON.stringify(conversationId ? { conversation_id: conversationId } : {})');
    expect(BROWSER_HELPERS).not.toContain('page.goto(conversationId ?');
    expect(BROWSER_HELPERS).toContain(
      `const refresh = conversationId ? null : page.getByTestId('refresh-conversations-button')`,
    );
    expect(BROWSER_HELPERS).toContain('page.waitForResponse((candidate) => {');
    expect(BROWSER_HELPERS).toContain("request.method() === 'POST'");
    expect(BROWSER_HELPERS).toContain("new URL(candidate.url()).pathname === '/api/v1/graph/invitation-accept'");
    expect(BROWSER_HELPERS).toContain("body?.status !== 'SUCCESS'");
    expect(BROWSER_HELPERS).not.toMatch(/waitForResponse\([\s\S]{0,500}timeout\s*:/);
  });

  it('keeps full-history inbox reconciliation behind the explicit refresh action', () => {
    expect(INBOX_VIEW).not.toMatch(/useEffect\(\(\) => \{\s*void fetchConversations\(\)/);
    expect(INBOX_VIEW).toContain('const handleRefresh = useCallback(async () => {');
    expect(INBOX_VIEW).toContain('await fetchConversations();');
    expect(INBOX_VIEW).toContain('onClick={() => void handleRefresh()}');
  });

  it('opens installed matrix assets through the live URL-first review action', () => {
    const helperStart = SHARE_MATRIX.indexOf('async function downloadAndOpenAssetClean(');
    const helperEnd = SHARE_MATRIX.indexOf('// ─── Scenario A:', helperStart);
    const helper = SHARE_MATRIX.slice(helperStart, helperEnd);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(helper).toContain('getByTestId(chipTestId).first().click()');
    expect(helper).toContain("getByTestId('asset-review-dialog')");
    expect(helper).toContain("getByTestId('asset-open-entity').click()");
    expect(helper).not.toContain('inst.page.goto(');
  });

  it('keeps transcript reception behind the staged project-install gate', () => {
    expect(TRANSCRIPT_SHARE).toContain("receive_policy='auto', so the review gate must choose a project");
    expect(TRANSCRIPT_SHARE).toContain("'staged MessageAttachment on receiver'");
    expect(TRANSCRIPT_SHARE).toContain('/graph/message_attachment/${ma.id}/install');
    expect(TRANSCRIPT_SHARE).toContain("scope: 'project'");
    expect(TRANSCRIPT_SHARE).toContain('project_id: project.id');
    expect(TRANSCRIPT_SHARE).toContain("path.join(projectDir, '.claude', 'transcripts'");
    expect(TRANSCRIPT_SHARE).toContain('/graph/claude_session/${id}');
    expect(TRANSCRIPT_SHARE).toContain("method: 'DELETE'");
  });

  it('runs all three pairs without sourcing credentials or launching services', () => {
    for (const key of [
      'FLOWPAD_HUB_URL',
      'FLOW_INSTANCE',
      'SHARE_INST_1',
      'SHARE_INST_2',
      'ALICE_EMAIL',
      'ALICE_PW',
      'BOB_EMAIL',
      'BOB_PW',
    ]) {
      expect(PAIRED_RUNNER).toContain(`\${${key}:?`);
    }
    expect(PAIRED_RUNNER).toContain('process.kill(pid, 0)');
    expect(PAIRED_RUNNER).toContain('launcher.backend_pid');
    expect(PAIRED_RUNNER).toContain('launcher.frontend_pid');
    expect(PAIRED_RUNNER).toContain('sleep 8  # let bob pre-warm');
    expect(PAIRED_RUNNER).toMatch(/run_pair\(\)[\s\S]*cleanup_rendezvous[\s\S]*echo "\[paired\] running/);
    expect(PAIRED_RUNNER).toContain('run_pair tests/hub/matrix.alice.test.ts tests/hub/matrix.bob.test.ts');
    expect(PAIRED_RUNNER).toContain(
      'run_pair tests/hub/conversation_messages.test.ts tests/hub/conversation_messages.bob.test.ts',
    );
    expect(PAIRED_RUNNER).toContain('run_pair tests/hub/rename.alice.test.ts tests/hub/rename.bob.test.ts');
    expect(PAIRED_RUNNER.match(/\/tmp\/flowpad_[a-z_]+\.txt/g)).toHaveLength(6);
    expect(PAIRED_RUNNER).not.toContain('source .env.local');
    expect(PAIRED_RUNNER).not.toContain('instance_ctl.sh');
    expect(PAIRED_RUNNER).not.toContain('bobqa');
    expect(PAIRED_RUNNER).not.toContain('VITE_API_URL=');
  });
});

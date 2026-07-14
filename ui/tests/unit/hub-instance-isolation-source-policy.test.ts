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
const ROOT_CONFIG = repoSource('ui/vitest.config.ts');
const PAIRED_RUNNER = repoSource('scripts/run_hub_paired.sh');

const TWO_INSTANCE_FILES = [
  'asset_share_index_matrix.test.ts',
  'community_two_client.test.ts',
  'doc_comment_sync.test.ts',
  'git_artifact_bookmark_two_client.test.ts',
  'git_artifact_share_wizard.test.ts',
  'member_role_change.test.ts',
  'plan_share.test.ts',
  'share_matrix.ui.test.ts',
  'skill_run_vibe_mcp_ui.ui.test.ts',
  'skill_share_two_client.test.ts',
  'spora_setup_vibe.ui.test.ts',
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
    expect(HUB_CONFIG).toContain('viteConfig({ mode, command: \'serve\' }');
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

  it('keeps the community staff path failing loudly when authorization is absent', () => {
    const source = hubSource('community_two_client.test.ts');
    expect(source).toContain('getAliceCreds');
    expect(source).toContain('getBobCreds');
    expect(source).toContain('hubLogin(guest.email, guestPassword)');
    expect(source).toContain('hubLogin(staff.email, staffPassword)');
    expect(source).toContain("throw new Error(\n        `[community test] staff '${staff.email}' cannot read the community queue;");
    expect(source).not.toContain("`${staff.name}-pw-1234`");
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

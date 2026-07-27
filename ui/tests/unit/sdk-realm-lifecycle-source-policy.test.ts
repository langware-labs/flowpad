import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(resolve(__dirname, '..', relative), 'utf8');

const REALM_CONSUMERS = [
  'api/project_context_dir.test.ts',
  'long_tests/_backend_lifecycle.ts',
  'long_tests/context_folder_real_worker.test.ts',
  'long_tests/decker_generate_deck_real_worker.test.ts',
  'long_tests/reindex_flow_real_worker.test.ts',
  'long_tests/wizard_process_event.test.ts',
  'headless/full-analysis-flow.test.tsx',
  'headless/full_app_smoke.test.tsx',
  'headless/skill_edit_roundtrip.test.tsx',
  'hub/_instances.ts',
] as const;

const LOG_HANDLE_OWNERS = [
  'api/project_context_dir.test.ts',
  'api/project_fetch_fast.test.ts',
  'long_tests/context_folder_real_worker.test.ts',
  'long_tests/decker_generate_deck_real_worker.test.ts',
  'long_tests/reindex_flow_real_worker.test.ts',
] as const;

describe('disposable SDK realm lifecycle source policy', () => {
  it.each(REALM_CONSUMERS)('%s uses the lifecycle owner, not a raw global override', (file) => {
    const source = read(file);
    expect(source).toMatch(/createSdk(?:Main)?Realm/);
    expect(source).not.toContain('__FLOWPAD_API_URL__');
    expect(source).not.toContain('resetModules()');
  });

  it('scopes the override to module evaluation and disposes only registered realms', () => {
    const helper = read('_sdk_realm.ts');
    expect(helper).toContain('const hadPrevious = Object.prototype.hasOwnProperty.call(globals, key);');
    expect(helper).toContain('if (hadPrevious) globals[key] = previous;');
    expect(helper).toContain('else delete globals[key];');
    expect(helper).toContain('sdk.connectionManager.dispose();');
    expect(helper).toContain('ownedRealms.delete(realm);');
    expect(helper).toContain('vi.resetModules();');
  });

  it.each(LOG_HANDLE_OWNERS)('%s closes the spawned-backend log FileHandle', (file) => {
    expect(read(file)).toMatch(/await logHandle\.close\(\)/);
  });

  it('keeps the reindex worker in the native Claude auth realm unless Claude configured an override', () => {
    const source = read('long_tests/reindex_flow_real_worker.test.ts');
    expect(source).toContain('const claudeConfigDir = backendEnv.CLAUDE_CONFIG_DIR;');
    expect(source).toContain('backendEnv.FLOWPAD_CLAUDE_HOME = claudeConfigDir;');
    expect(source).toContain('delete backendEnv.FLOWPAD_CLAUDE_HOME;');
    expect(source).toContain('delete backendEnv.CLAUDE_CONFIG_DIR;');
    expect(source).not.toContain('FLOWPAD_CLAUDE_HOME: CLAUDE_TRANSCRIPT_HOME');
  });
});

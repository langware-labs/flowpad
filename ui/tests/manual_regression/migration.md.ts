/**
 * Structural guard for the migration runbook in migration.md.
 *
 * The real old-wheel → new-wheel validation remains
 * `tests/migration_e2e/run.sh`; it intentionally exceeds the per-file browser
 * gate. These checks keep the documented runner, status machine, migration
 * recipe, and Docker harness connected.
 */
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');

function source(relativePath: string): string {
  return readFileSync(path.join(REPO, relativePath), 'utf8');
}

test.describe('Migration runbook contract', () => {
  test('runner and 0.2.26 consolidation recipe preserve the documented seams', () => {
    const runner = source('flow_sdk/migrations/runner.py');
    const status = source('flow_sdk/migrations/status.py');
    const cli = source('flow_sdk/cli/flow_cli.py');
    const recipe = source('flow_sdk/system_projects/flowpad_assistant/migrations/0.2.26/scripts/migrate.py');
    const registrationIndex = runner.indexOf('sys.modules[mod_name] = module');
    const executionIndex = runner.indexOf('spec.loader.exec_module(module)');

    expect(runner).toContain('def run_if_needed(');
    expect(registrationIndex).toBeGreaterThanOrEqual(0);
    expect(executionIndex).toBeGreaterThan(registrationIndex);
    expect(status).toContain('def decide_action(');
    expect(status).toContain('SKIP_COMPLETED');
    expect(status).toContain('SKIP_IN_FLIGHT');
    expect(cli).toContain('migration_runner.run_if_needed()');
    expect(recipe).toContain('def run(');
    expect(recipe).toMatch(/copytree\([\s\S]*dirs_exist_ok=True/);
  });

  test('every packaged script migration exposes run and the Docker harness is intact', () => {
    const migrationsRoot = path.join(REPO, 'flow_sdk/system_projects/flowpad_assistant/migrations');
    const versions = readdirSync(migrationsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(versions).toContain('0.2.26');
    for (const version of versions) {
      const recipePath = path.join(migrationsRoot, version, 'scripts', 'migrate.py');
      if (existsSync(recipePath)) {
        expect(readFileSync(recipePath, 'utf8'), `${version} migration entry point`).toContain('def run(');
      }
    }

    for (const relativePath of [
      'tests/migration_e2e/Dockerfile',
      'tests/migration_e2e/in_container.sh',
      'tests/migration_e2e/run.sh',
      'tests/migration_e2e/seed_assets.py',
      'tests/migration_e2e/verify_post_migration.sh',
      'tests/migration_e2e/test_docker_migration.py',
    ]) {
      expect(existsSync(path.join(REPO, relativePath)), relativePath).toBe(true);
    }
    expect(source('tests/migration_e2e/run.sh')).toContain('MIGRATION E2E: PASS');
  });
});

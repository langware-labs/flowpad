/**
 * Source-level guard for the live-backend headless tier.
 *
 * Phase 8 writes real entities. It must bind only to the disposable
 * FLOW_INSTANCE selected by the caller, fail closed when that instance is not
 * provably live, and never turn missing infrastructure into passing tests.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const headlessSource = (name: string) => readFileSync(resolve(__dirname, `../headless/${name}`), 'utf8');

const BACKEND = headlessSource('_backend.ts');
const HARNESS = headlessSource('_harness.ts');
const CONFIG = headlessSource('vitest.config.ts');
const DOCS = headlessSource('CLAUDE.md');
const PACKAGE = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const FULL_ANALYSIS = headlessSource('full-analysis-flow.test.tsx');
const TEST_SOURCES = [
  headlessSource('full-analysis-flow.test.tsx'),
  headlessSource('full_app_smoke.test.tsx'),
  headlessSource('skill_edit_roundtrip.test.tsx'),
];

describe('headless launched-instance isolation source policy', () => {
  it('resolves only the explicit instance env + matching live launcher', () => {
    expect(BACKEND).toContain('export async function resolveLiveBackend(instanceName: string)');
    expect(BACKEND).toContain('`.env.${instanceName}.local`');
    expect(BACKEND).toContain('inst.FLOW_INSTANCE !== instanceName');
    expect(BACKEND).toContain("path.join(flowHome, 'instances', instanceName, 'launcher.json')");
    expect(BACKEND).toContain('launcher.name !== instanceName');
    expect(BACKEND).toContain('Number(launcher.backend_port) !== Number(port)');
    expect(BACKEND).toContain("typeof launcher.env_file === 'string' ? path.resolve(launcher.env_file) : ''");
    expect(BACKEND).toContain('launcherEnvFile !== expectedEnvFile');
    expect(BACKEND).toContain('process.kill(pid, 0)');
    expect(BACKEND).toContain('/api/v1/graph/bootstrap');

    expect(BACKEND).not.toContain("instanceName = 'dev-1'");
    expect(BACKEND).not.toContain("readEnvFile('.env.local')");
    expect(BACKEND).not.toContain('const candidates');
  });

  it('fails closed instead of soft-passing when infrastructure is absent', () => {
    expect(HARNESS).toContain("const instanceName = process.env.FLOW_INSTANCE?.trim() || '';");
    expect(HARNESS).toContain('FLOW_INSTANCE is required');
    expect(HARNESS).toContain("FLOW_INSTANCE='${instanceName}' is not a matching live instance_ctl backend");
    expect(HARNESS).not.toContain('console.warn(');

    for (const contents of TEST_SOURCES) {
      expect(contents).toContain(
        "if (!live) throw new Error('headless backend preflight did not resolve FLOW_INSTANCE');",
      );
      expect(contents).not.toMatch(/if\s*\(\s*!backend\.current\s*\)\s*return\b/);
    }
  });

  it('binds compile-time config and jsdom origin to FLOW_INSTANCE mode', () => {
    expect(CONFIG).toContain("const instanceName = process.env.FLOW_INSTANCE || '';");
    expect(CONFIG).toContain("const mode = instanceName || 'test';");
    expect(CONFIG).toContain("const env = loadEnv(mode, path.resolve(__dirname, '../../..'), '');");
    expect(CONFIG).toContain('env.FLOW_INSTANCE === instanceName');
    expect(CONFIG).toContain("viteConfig({ mode, command: 'serve' }");
    expect(CONFIG).toContain('__API_URL__: JSON.stringify(apiUrl)');
    expect(CONFIG).toContain('__REACT_INSTANCE_NAME__: JSON.stringify(instanceName)');
    expect(CONFIG).toContain('__REACT_BACKEND_PORT__: JSON.stringify(port)');
    expect(CONFIG).not.toContain("loadEnv('test'");
    expect(CONFIG).not.toContain("|| '9007'");
  });

  it('serializes full-app files at the root CLI boundary while retaining fork isolation', () => {
    expect(PACKAGE.scripts['test:vitest:headless']).toContain('--no-file-parallelism');
    expect(CONFIG).toContain("pool: 'forks'");
    expect(CONFIG).toContain('isolate: true');
    expect(CONFIG).not.toContain('fileParallelism: false');
    expect(CONFIG).not.toContain('minForks');
    expect(CONFIG).not.toContain('maxForks');
    expect(CONFIG).not.toContain('singleFork: true');
  });

  it('uses a collision-proof, optionally isolated transcript fixture', () => {
    expect(FULL_ANALYSIS).toContain("import { randomUUID } from 'node:crypto';");
    expect(FULL_ANALYSIS).toContain('const SID = randomUUID();');
    expect(FULL_ANALYSIS).toContain('process.env.FLOWPAD_CLAUDE_HOME');
    expect(FULL_ANALYSIS).toContain("flag: 'wx'");
    expect(FULL_ANALYSIS).toContain('rmSync(dir, { recursive: true, force: true })');
    expect(FULL_ANALYSIS).not.toContain('55555555-5555-4555-8555-555555555555');
  });

  it('documents disposable-instance ownership and no infrastructure skip', () => {
    expect(DOCS).toContain('FLOW_INSTANCE=<disposable-name>');
    expect(DOCS).toContain('There is no developer-instance or `.env.local` fallback.');
    expect(DOCS).toContain('Missing or mismatched infrastructure fails the suite');
    expect(DOCS).not.toContain('Soft-skip first');
  });
});

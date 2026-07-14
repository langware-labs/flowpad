/**
 * Source-level guard for API tests that use a launched disposable instance.
 *
 * These tests may restart their selected backend, so a stale env file or a
 * hardcoded developer-instance name is not an acceptable safety gate. Keep the
 * SDK on the API project's FLOW_INSTANCE-selected realm and require launcher
 * identity, port, and PID liveness before enabling each suite.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertClaudeTranscriptHomesAligned } from '../api/_claude_transcript_home';

const source = (name: string) => readFileSync(resolve(__dirname, `../api/${name}.test.ts`), 'utf8');

const API_SOURCES = [
  ['pty_survives_restart', source('pty_survives_restart')],
  ['agentic_survives_restart', source('agentic_survives_restart')],
  ['chat_ui_vs_pty_content', source('chat_ui_vs_pty_content')],
] as const;

const API_CONFIG = readFileSync(resolve(__dirname, '../api/vitest.config.ts'), 'utf8');

describe('API launched-instance isolation source policy', () => {
  it('fails closed when Flowpad and Claude resolve different transcript roots', () => {
    expect(() =>
      assertClaudeTranscriptHomesAligned(
        {
          FLOWPAD_CLAUDE_HOME: '/tmp/cycle-owned-claude',
          CLAUDE_CONFIG_DIR: '/tmp/real-claude-writer',
        },
        '/tmp/test-user',
      ),
    ).toThrow(/Claude transcript roots are misaligned/);

    expect(() =>
      assertClaudeTranscriptHomesAligned(
        {
          FLOWPAD_CLAUDE_HOME: '/tmp/cycle-owned-claude',
          CLAUDE_CONFIG_DIR: '/tmp/cycle-owned-claude',
        },
        '/tmp/test-user',
      ),
    ).not.toThrow();
  });

  it.each(API_SOURCES)('%s requires a matching live FLOW_INSTANCE launcher', (_name, contents) => {
    expect(contents).toContain("const INSTANCE = process.env.FLOW_INSTANCE || '';");
    expect(contents).toContain('`.env.${INSTANCE}.local`');
    expect(contents).toContain('`.flow/instances/${INSTANCE}/launcher.json`');
    expect(contents).toContain('launcher.name !== INSTANCE');
    expect(contents).toContain('Number(launcher.backend_port) !== Number(PORT)');
    expect(contents).toContain('process.kill(backendPid, 0)');
    expect(contents).toContain('const suite = INSTANCE_READY ? describe : describe.skip;');

    expect(contents).toContain("import * as sdk from '@sdk';");
    expect(contents).toContain('await apiTestSetup();');
    expect(contents).not.toContain('__FLOWPAD_API_URL__');
    expect(contents).not.toContain('resetModules');
    expect(contents).not.toMatch(/await\s+import\(['"]@sdk['"]\)/);
    expect(contents).not.toContain('dev-1');
  });

  it.each([
    ['pty_survives_restart', API_SOURCES[0][1]],
    ['agentic_survives_restart', API_SOURCES[1][1]],
  ])('%s relaunches only the selected instance', (_name, contents) => {
    expect(contents).toContain(
      "execFileSync('scripts/instance_ctl.sh', ['launch', INSTANCE], { cwd: REPO_ROOT, stdio: 'ignore' });",
    );
    expect(contents).not.toMatch(/\['launch',\s*['"][^'"]+['"]\]/);
  });

  it('preserves the bare-PTY bootstrap readiness probe', () => {
    expect(API_SOURCES[0][1]).toContain(
      "execFileSync('curl', ['-sf', '--max-time', '2', `http://localhost:${PORT}/api/v1/graph/bootstrap`], {\n" +
        "      stdio: 'ignore',\n" +
        '    });',
    );
  });

  it('binds the API project SDK define and jsdom origin to FLOW_INSTANCE mode', () => {
    expect(API_CONFIG).toContain("const mode = process.env.FLOW_INSTANCE || 'test';");
    expect(API_CONFIG).toContain("const env = loadEnv(mode, path.resolve(__dirname, '../../..'), '');");
    expect(API_CONFIG).toContain("viteConfig({ mode, command: 'serve' }");
    expect(API_CONFIG).toContain("const port = env.LOCAL_SERVER_PORT || '9007';");
    expect(API_CONFIG).toContain('url: `http://localhost:${port}`');
  });
});

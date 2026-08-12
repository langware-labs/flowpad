/**
 * Source-level guard for the React tier's live backend boundary.
 *
 * Most React files are DOM-only, but a fixed set bootstraps the real SDK and
 * can write entities or host files. The project-wide setup must therefore bind
 * every file to an explicitly selected, launcher-owned disposable instance.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const reactSource = (name: string) => readFileSync(resolve(__dirname, `../react/${name}`), 'utf8');
const CONFIG = reactSource('vitest.config.ts');
const SETUP = reactSource('reactSetup.ts');
const INSTANCE = reactSource('_instance.ts');
const CHATS_RECENCY = reactSource('chats-open-recency.test.ts');
const ASSET_LOADER = reactSource('asset-loader-project-context.test.tsx');

function filesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(root, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [child];
  });
}

describe('React launched-instance isolation source policy', () => {
  it('binds the SDK define and jsdom origin to FLOW_INSTANCE mode', () => {
    expect(CONFIG).toContain("const instanceName = process.env.FLOW_INSTANCE?.trim() || '';");
    expect(CONFIG).toContain("const mode = instanceName || 'test';");
    expect(CONFIG).toContain("const env = loadEnv(mode, path.resolve(__dirname, '../../..'), '');");
    expect(CONFIG).toContain('env.FLOW_INSTANCE === instanceName');
    expect(CONFIG).toContain("viteConfig({ mode, command: 'serve' }");
    expect(CONFIG).toContain('__API_URL__: JSON.stringify(apiUrl)');
    expect(CONFIG).toContain('__REACT_INSTANCE_NAME__: JSON.stringify(instanceName)');
    expect(CONFIG).not.toContain("loadEnv('test'");
    expect(CONFIG).not.toContain("|| '9007'");
  });

  it('fails the React project closed on missing or mismatched launcher ownership', () => {
    expect(SETUP).toContain("const selectedInstance = process.env.FLOW_INSTANCE?.trim() || '';");
    expect(SETUP).toContain('react vitest requires FLOW_INSTANCE=<disposable-name>');
    expect(SETUP).toContain('resolveReactTestInstance(selectedInstance)');
    expect(SETUP).toContain('__REACT_INSTANCE_NAME__ !== selectedInstance');
    expect(SETUP).toContain('__REACT_BACKEND_PORT__ !== selectedPort');

    expect(INSTANCE).toContain('`.env.${name}.local`');
    expect(INSTANCE).toContain('env.FLOW_INSTANCE !== name');
    expect(INSTANCE).toContain("path.join(flowHome, 'instances', name, 'launcher.json')");
    expect(INSTANCE).toContain('launcher.name !== name');
    expect(INSTANCE).toContain('Number(launcher.backend_port) !== Number(port)');
    expect(INSTANCE).toContain('launcherEnvFile !== expectedEnvFile');
    expect(INSTANCE).toContain('process.kill(pid, 0)');
    expect(INSTANCE).not.toContain('fetch(');
    expect(INSTANCE).not.toContain('setTimeout(');
  });

  it('keeps the audited real-SDK file set visible behind the project-wide gate', () => {
    const root = resolve(__dirname, '../react');
    const liveSdkFiles = filesUnder(root)
      .filter((file) => /\.test\.tsx?$/.test(file))
      .filter((file) => readFileSync(file, 'utf8').includes('apiTestSetup'))
      .map((file) => file.slice(root.length + 1))
      .sort();

    expect(liveSdkFiles).toEqual([
      'agentic_process_stress.test.ts',
      'asset-loader-project-context.test.tsx',
      'chat-history-row-rename-sync.test.tsx',
      'chats-open-recency.test.ts',
      'dock-dead-scope-tab-setup.test.tsx',
      'project-context-locale-follows.test.ts',
      'project-locale-memory.test.ts',
      'project-view-mode-memory.test.ts',
      'pty_corruption.test.ts',
      'reactivity.test.ts',
      'shell_stress.test.ts',
      'unit/hooks/useClaudeHistory.test.tsx',
      'unit/hooks/useEntityByPath.test.tsx',
      'unit/useFS.test.tsx',
      'vibe-switch-project-locale.test.ts',
    ]);
  });

  it('writes the transcript fixture under the backend-selected Claude home', () => {
    expect(CHATS_RECENCY).toContain(
      "process.env.FLOWPAD_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')",
    );
    expect(CHATS_RECENCY).toContain("path.join(CLAUDE_HOME, 'projects'");
    expect(CHATS_RECENCY).toMatch(/path\.join\(FLOW_HOME,\s*'instances',\s*FLOW_INSTANCE,\s*'react-fixtures'/s);
  });

  it('materializes and removes the asset-loader fixture under the selected instance', () => {
    expect(ASSET_LOADER).toContain("const FLOW_INSTANCE = process.env.FLOW_INSTANCE?.trim() || '';");
    expect(ASSET_LOADER).toMatch(/path\.join\(FLOW_HOME,\s*'instances',\s*FLOW_INSTANCE,\s*'react-fixtures'/s);
    expect(ASSET_LOADER).toContain('rmSync(PROJECT_ROOT, { recursive: true, force: true })');
    expect(ASSET_LOADER).not.toContain("const PROJECT_ROOT = '/private/tmp'");
    expect(ASSET_LOADER).not.toContain("const SKILL_PATH = '/private/tmp");
  });
});

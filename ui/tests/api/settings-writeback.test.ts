import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  ClaudeSettingsJsonRecordList,
  dataContext,
} from '@sdk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

/**
 * ClaudeSettings write-back tests.
 *
 * These tests use temp folders so the delta from production code is minimal —
 * only the file paths differ.  A running backend at localhost:9007 is required.
 */
describe('ClaudeSettings write-back', () => {
  const signupInfo = getTestSignupInfo();
  let tmpDir: string;
  let computeNodeId: string;

  beforeAll(async () => {
    await apiTestSetup(signupInfo, 'settings-writeback');
    computeNodeId = dataContext.computeNode?.id ?? '@local';
  });

  beforeEach(() => {
    // Fresh temp dir for each test — use .claude/ subdirectory so the path
    // passes the backend security check (only .claude/ paths are allowed).
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-settings-'));
    tmpDir = path.join(base, '.claude');
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    // Best-effort cleanup — remove the parent of .claude/ (the real temp root)
    try {
      const parentDir = tmpDir ? path.dirname(tmpDir) : null;
      if (parentDir && fs.existsSync(parentDir)) {
        fs.rmSync(parentDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  it('loads settings from a temp JSON file', async () => {
    // Create a settings file
    fs.writeFileSync(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({ model: 'sonnet', env: { FOO: 'bar' } }),
    );

    const rl = new ClaudeSettingsJsonRecordList(
      computeNodeId,
      path.join(tmpDir, 'settings.json'),
    );
    await rl.load();

    expect(rl.loaded).toBe(true);
    expect(rl.root).toBeDefined();
    expect(rl.root?.model).toBe('sonnet');
  });

  it('writes model change and verifies raw JSON', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({ model: 'sonnet', env: { FOO: 'bar' } }),
    );

    const rl = new ClaudeSettingsJsonRecordList(
      computeNodeId,
      path.join(tmpDir, 'settings.json'),
    );
    await rl.load();

    // Update model via SDK — jsonPath '' targets the root record
    await rl.updateRecord('', { model: 'opus' });

    // Read raw file to verify
    const raw = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'),
    );
    expect(raw.model).toBe('opus');
    // Original fields preserved
    expect(raw.env.FOO).toBe('bar');
  });

  it('writes permissions and verifies nested JSON', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        model: 'sonnet',
        permissions: { allow: ['Bash(*)'], deny: [] },
      }),
    );

    const rl = new ClaudeSettingsJsonRecordList(
      computeNodeId,
      path.join(tmpDir, 'settings.json'),
    );
    await rl.load();

    // Update permissions sub-record
    await rl.updateRecord('/permissions', { deny: ['Write(*)'] });

    const raw = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'),
    );
    expect(raw.permissions.deny).toEqual(['Write(*)']);
    // Original model preserved
    expect(raw.model).toBe('sonnet');
  });

  it('writes env var and verifies in raw JSON', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({ env: { FOO: 'bar' } }),
    );

    const rl = new ClaudeSettingsJsonRecordList(
      computeNodeId,
      path.join(tmpDir, 'settings.json'),
    );
    await rl.load();

    // Update env dict — add a new key
    await rl.updateRecord('', { env: { FOO: 'bar', NEW_VAR: 'hello' } });

    const raw = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'),
    );
    expect(raw.env.FOO).toBe('bar');
    expect(raw.env.NEW_VAR).toBe('hello');
  });

  it('delta is minimal — only changed keys written', async () => {
    const initial = {
      model: 'sonnet',
      language: 'en',
      env: { A: '1', B: '2' },
    };
    fs.writeFileSync(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify(initial, null, 2),
    );

    const rl = new ClaudeSettingsJsonRecordList(
      computeNodeId,
      path.join(tmpDir, 'settings.json'),
    );
    await rl.load();

    // Change only model
    await rl.updateRecord('', { model: 'opus' });

    const raw = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'),
    );
    // Changed field updated
    expect(raw.model).toBe('opus');
    // Untouched fields preserved
    expect(raw.language).toBe('en');
    expect(raw.env).toEqual({ A: '1', B: '2' });
  });
});

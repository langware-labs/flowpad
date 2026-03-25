import { describe, it, expect } from 'vitest';
import {
  ClaudeSettingsJsonFsRecord,
  ClaudePermissionsFsRecord,
  ClaudeSandboxFsRecord,
  ClaudeAttributionFsRecord,
  overlayRecord,
  overlaySettingsLists,
  ClaudeSettingsJsonRecordList,
} from '@sdk';
import { flattenSettings, matchesSearch } from '@src/components/settings-view/settings-utils';

/**
 * Helper: create a record with fields assigned AFTER construction.
 *
 * FsRecord subclasses have class field initializers that run after super(),
 * so passing data to the constructor gets overwritten by defaults.
 * This helper creates a default instance then applies overrides.
 */
function makeRecord<T>(Cls: new () => T, overrides: Partial<Record<string, unknown>>): T {
  const inst = new Cls();
  Object.assign(inst, overrides);
  return inst;
}

// ── overlayRecord ────────────────────────────────────────

describe('overlayRecord', () => {
  it('higher scope string overrides lower scope', () => {
    const user = makeRecord(ClaudeSettingsJsonFsRecord, { model: 'opus' });
    const project = makeRecord(ClaudeSettingsJsonFsRecord, { model: 'sonnet' });
    const result = overlayRecord(user, project, ClaudeSettingsJsonFsRecord);
    expect(result.model).toBe('sonnet');
  });

  it('lower scope preserved when higher has default/empty', () => {
    const user = makeRecord(ClaudeSettingsJsonFsRecord, { model: 'opus', language: 'en' });
    const project = makeRecord(ClaudeSettingsJsonFsRecord, { model: '' }); // default
    const result = overlayRecord(user, project, ClaudeSettingsJsonFsRecord);
    expect(result.model).toBe('opus'); // higher is default → keep lower
    expect(result.language).toBe('en'); // not set in higher → keep lower
  });

  it('arrays in higher override lower (not merge)', () => {
    const user = makeRecord(ClaudePermissionsFsRecord, { allow: ['Bash(*)'] });
    const project = makeRecord(ClaudePermissionsFsRecord, { allow: ['Read(*)'] });
    const result = overlayRecord(user, project, ClaudePermissionsFsRecord);
    expect(result.allow).toEqual(['Read(*)']);
  });

  it('empty array in higher is treated as default — keeps lower', () => {
    const user = makeRecord(ClaudePermissionsFsRecord, { allow: ['Bash(*)'] });
    const project = makeRecord(ClaudePermissionsFsRecord, { allow: [] }); // default
    const result = overlayRecord(user, project, ClaudePermissionsFsRecord);
    expect(result.allow).toEqual(['Bash(*)']);
  });

  it('dicts (env) merge correctly — higher keys win', () => {
    const user = makeRecord(ClaudeSettingsJsonFsRecord, { env: { FOO: 'from_user', BAR: 'user_bar' } });
    const project = makeRecord(ClaudeSettingsJsonFsRecord, { env: { FOO: 'from_project', BAZ: 'proj_baz' } });
    const result = overlayRecord(user, project, ClaudeSettingsJsonFsRecord);
    expect(result.env).toEqual({ FOO: 'from_project', BAR: 'user_bar', BAZ: 'proj_baz' });
  });

  it('boolean true in higher overrides false in lower', () => {
    const user = makeRecord(ClaudeSettingsJsonFsRecord, { always_thinking_enabled: false });
    const project = makeRecord(ClaudeSettingsJsonFsRecord, { always_thinking_enabled: true });
    const result = overlayRecord(user, project, ClaudeSettingsJsonFsRecord);
    expect(result.always_thinking_enabled).toBe(true);
  });

  it('boolean false in higher is default — keeps lower true', () => {
    const user = makeRecord(ClaudeSettingsJsonFsRecord, { always_thinking_enabled: true });
    const project = makeRecord(ClaudeSettingsJsonFsRecord, { always_thinking_enabled: false }); // default
    const result = overlayRecord(user, project, ClaudeSettingsJsonFsRecord);
    expect(result.always_thinking_enabled).toBe(true);
  });

  it('3-way overlay: local > project > user', () => {
    const user = makeRecord(ClaudeSettingsJsonFsRecord, { model: 'opus', language: 'en' });
    const project = makeRecord(ClaudeSettingsJsonFsRecord, { model: 'sonnet' });
    const local = makeRecord(ClaudeSettingsJsonFsRecord, { model: 'haiku' });

    // user < project
    let merged = overlayRecord(user, project, ClaudeSettingsJsonFsRecord);
    // then merged < local
    merged = overlayRecord(merged, local, ClaudeSettingsJsonFsRecord);

    expect(merged.model).toBe('haiku');
    expect(merged.language).toBe('en'); // from user, untouched
  });

  it('permissions sub-record overlay', () => {
    const user = makeRecord(ClaudePermissionsFsRecord, {
      allow: ['Bash(*)'],
      deny: ['Write(*)'],
      default_mode: 'plan',
    });
    const project = makeRecord(ClaudePermissionsFsRecord, {
      allow: ['Read(*)'],
      default_mode: '', // default → keep user's
    });
    const result = overlayRecord(user, project, ClaudePermissionsFsRecord);
    expect(result.allow).toEqual(['Read(*)']); // overridden
    expect(result.deny).toEqual(['Write(*)']); // from user
    expect(result.default_mode).toBe('plan'); // project is default → user wins
  });

  it('sandbox sub-record overlay', () => {
    const user = makeRecord(ClaudeSandboxFsRecord, {
      enabled: true,
      network_http_proxy_port: 8080,
    });
    const local = makeRecord(ClaudeSandboxFsRecord, {
      enabled: true,
      network_http_proxy_port: 9090,
    });
    const result = overlayRecord(user, local, ClaudeSandboxFsRecord);
    expect(result.enabled).toBe(true);
    expect(result.network_http_proxy_port).toBe(9090);
  });

  it('null/undefined records handled gracefully', () => {
    const result1 = overlayRecord(undefined, undefined, ClaudeSettingsJsonFsRecord);
    expect(result1.model).toBe(''); // default

    const user = makeRecord(ClaudeSettingsJsonFsRecord, { model: 'opus' });
    const result2 = overlayRecord(user, undefined, ClaudeSettingsJsonFsRecord);
    expect(result2.model).toBe('opus');

    const result3 = overlayRecord(undefined, user, ClaudeSettingsJsonFsRecord);
    expect(result3.model).toBe('opus');
  });
});

// ── overlaySettingsLists ─────────────────────────────────

describe('overlaySettingsLists', () => {
  it('merges all sub-records across scopes', () => {
    // Create mock record lists with known sub-records
    const userList = Object.create(ClaudeSettingsJsonRecordList.prototype) as ClaudeSettingsJsonRecordList;
    const projectList = Object.create(ClaudeSettingsJsonRecordList.prototype) as ClaudeSettingsJsonRecordList;

    Object.defineProperty(userList, 'root', {
      get: () => makeRecord(ClaudeSettingsJsonFsRecord, { model: 'opus', language: 'en' }),
    });
    Object.defineProperty(userList, 'permissions', {
      get: () => makeRecord(ClaudePermissionsFsRecord, { allow: ['Bash(*)'] }),
    });
    Object.defineProperty(userList, 'sandbox', { get: () => undefined });
    Object.defineProperty(userList, 'attribution', {
      get: () => makeRecord(ClaudeAttributionFsRecord, { commit: 'user-commit' }),
    });

    Object.defineProperty(projectList, 'root', {
      get: () => makeRecord(ClaudeSettingsJsonFsRecord, { model: 'sonnet' }),
    });
    Object.defineProperty(projectList, 'permissions', {
      get: () => makeRecord(ClaudePermissionsFsRecord, { deny: ['Write(*)'] }),
    });
    Object.defineProperty(projectList, 'sandbox', {
      get: () => makeRecord(ClaudeSandboxFsRecord, { enabled: true }),
    });
    Object.defineProperty(projectList, 'attribution', { get: () => undefined });

    const result = overlaySettingsLists(userList, projectList, null);

    expect(result.root?.model).toBe('sonnet');
    expect(result.root?.language).toBe('en');
    expect(result.permissions?.allow).toEqual(['Bash(*)']); // project allow is default/empty
    expect(result.permissions?.deny).toEqual(['Write(*)']);
    expect(result.sandbox?.enabled).toBe(true);
    expect(result.attribution?.commit).toBe('user-commit');
  });

  it('null record lists handled gracefully', () => {
    const result = overlaySettingsLists(null, null, null);
    // Should return defaults for each sub-record
    expect(result.root?.model).toBe('');
    expect(result.permissions?.allow).toEqual([]);
    expect(result.sandbox?.enabled).toBe(false);
    expect(result.attribution?.commit).toBe('');
  });
});

// ── flattenSettings with env vars ────────────────────────

describe('flattenSettings with env vars', () => {
  function makeRecordList(root?: ClaudeSettingsJsonFsRecord): ClaudeSettingsJsonRecordList {
    const list = Object.create(ClaudeSettingsJsonRecordList.prototype) as ClaudeSettingsJsonRecordList;
    Object.defineProperty(list, 'root', { get: () => root });
    Object.defineProperty(list, 'permissions', { get: () => undefined });
    Object.defineProperty(list, 'sandbox', { get: () => undefined });
    Object.defineProperty(list, 'attribution', { get: () => undefined });
    return list;
  }

  it('individual env vars extracted from env dict', () => {
    const userList = makeRecordList(
      makeRecord(ClaudeSettingsJsonFsRecord, {
        env: { ANTHROPIC_API_KEY: 'sk-test-123', ANTHROPIC_MODEL: 'haiku' },
      }),
    );

    const fields = flattenSettings(userList, null, null);
    const apiKeyField = fields.find((f) => f.key === 'env.ANTHROPIC_API_KEY');
    const modelField = fields.find((f) => f.key === 'env.ANTHROPIC_MODEL');

    expect(apiKeyField).toBeDefined();
    expect(apiKeyField!.effectiveValue).toBe('sk-test-123');
    expect(apiKeyField!.scope).toBe('user');

    expect(modelField).toBeDefined();
    expect(modelField!.effectiveValue).toBe('haiku');
  });

  it('env var search matches individual var name', () => {
    const userList = makeRecordList(
      makeRecord(ClaudeSettingsJsonFsRecord, {
        env: { ANTHROPIC_API_KEY: 'sk-test' },
      }),
    );

    const fields = flattenSettings(userList, null, null);
    const apiKeyField = fields.find((f) => f.key === 'env.ANTHROPIC_API_KEY')!;

    expect(matchesSearch(apiKeyField, 'ANTHROPIC')).toBe(true);
    expect(matchesSearch(apiKeyField, 'api key')).toBe(true); // matches label
    expect(matchesSearch(apiKeyField, 'sk-test')).toBe(true); // matches value
  });

  it('env var description is searchable', () => {
    const userList = makeRecordList(
      makeRecord(ClaudeSettingsJsonFsRecord, {
        env: { CLAUDE_CODE_USE_BEDROCK: '1' },
      }),
    );

    const fields = flattenSettings(userList, null, null);
    const bedrockField = fields.find((f) => f.key === 'env.CLAUDE_CODE_USE_BEDROCK')!;

    expect(matchesSearch(bedrockField, 'bedrock')).toBe(true);
    expect(matchesSearch(bedrockField, 'backend')).toBe(true); // matches description
  });

  it('scope precedence works for individual env vars', () => {
    const userList = makeRecordList(
      makeRecord(ClaudeSettingsJsonFsRecord, {
        env: { ANTHROPIC_MODEL: 'opus' },
      }),
    );
    const projectList = makeRecordList(
      makeRecord(ClaudeSettingsJsonFsRecord, {
        env: { ANTHROPIC_MODEL: 'sonnet' },
      }),
    );

    const fields = flattenSettings(userList, projectList, null);
    const modelField = fields.find((f) => f.key === 'env.ANTHROPIC_MODEL')!;

    expect(modelField.effectiveValue).toBe('sonnet');
    expect(modelField.scope).toBe('project');
    expect(modelField.userValue).toBe('opus');
  });

  it('env dict field still shows full dictionary', () => {
    const userList = makeRecordList(
      makeRecord(ClaudeSettingsJsonFsRecord, {
        env: { FOO: 'bar', BAZ: 'qux' },
      }),
    );

    const fields = flattenSettings(userList, null, null);
    const envDictField = fields.find((f) => f.key === 'env' && f.fieldType === 'dict')!;

    expect(envDictField.effectiveValue).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('field descriptions are passed through', () => {
    const fields = flattenSettings(null, null, null);
    const modelField = fields.find((f) => f.key === 'model')!;
    expect(modelField.description).toBe('Default model to use for conversations');

    const bedrockField = fields.find((f) => f.key === 'env.CLAUDE_CODE_USE_BEDROCK')!;
    expect(bedrockField.allowedValues).toEqual(['0', '1']);
  });
});

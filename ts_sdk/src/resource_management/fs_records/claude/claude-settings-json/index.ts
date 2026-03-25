/**
 * Claude settings.json barrel — re-exports all settings.json record types
 * plus the ClaudeSettingsJsonRecordList convenience class.
 */
export { ClaudeSettingsJsonFsRecord } from './base';
export { ClaudePermissionsFsRecord } from './permissions';
export { ClaudeSandboxFsRecord } from './sandbox';
export { ClaudeAttributionFsRecord } from './attribution';
export { overlayRecord, overlaySettingsLists } from './overlay';
export type { OverlayResult } from './overlay';

// ── ClaudeSettingsJsonRecordList ────────────────────────────

import { SourceFileRecordList } from '../../source-file-record-list';
import { RecordType } from '../../record-types';
import { ClaudeSettingsJsonFsRecord } from './base';
import { ClaudePermissionsFsRecord } from './permissions';
import { ClaudeSandboxFsRecord } from './sandbox';
import { ClaudeAttributionFsRecord } from './attribution';

/**
 * ClaudeSettingsJsonRecordList — reads `settings.json` via the backend and
 * extracts typed sub-records (root, permissions, sandbox, attribution).
 *
 * Supports write-back: use `updateRecord()` to persist changes through the
 * backend which writes back to the source JSON file.
 */
export class ClaudeSettingsJsonRecordList extends SourceFileRecordList {
  static override _listType = 'claude_settings_json';

  /** Root settings record (model, env, hooks, etc.). */
  get root(): ClaudeSettingsJsonFsRecord | undefined {
    return this.byType(RecordType.CLAUDE_SETTINGS_JSON)[0] as
      | ClaudeSettingsJsonFsRecord
      | undefined;
  }

  /** Permissions record. */
  get permissions(): ClaudePermissionsFsRecord | undefined {
    return this.byType(RecordType.CLAUDE_SETTINGS_JSON_PERMISSIONS)[0] as
      | ClaudePermissionsFsRecord
      | undefined;
  }

  /** Sandbox record. */
  get sandbox(): ClaudeSandboxFsRecord | undefined {
    return this.byType(RecordType.CLAUDE_SETTINGS_JSON_SANDBOX)[0] as
      | ClaudeSandboxFsRecord
      | undefined;
  }

  /** Attribution record. */
  get attribution(): ClaudeAttributionFsRecord | undefined {
    return this.byType(RecordType.CLAUDE_SETTINGS_JSON_ATTRIBUTION)[0] as
      | ClaudeAttributionFsRecord
      | undefined;
  }

  /** Convenience factory: create and immediately load. */
  static async load(computeNodeId: string): Promise<ClaudeSettingsJsonRecordList> {
    const list = new ClaudeSettingsJsonRecordList(computeNodeId);
    await list.load();
    return list;
  }

  /** Create a record list for the user-level ~/.claude/settings.json. */
  static forUser(computeNodeId: string): ClaudeSettingsJsonRecordList {
    return new ClaudeSettingsJsonRecordList(computeNodeId, '~/.claude/settings.json');
  }

  /** Create a record list for a project's .claude/settings.json. */
  static forProject(computeNodeId: string, projectDir: string): ClaudeSettingsJsonRecordList {
    return new ClaudeSettingsJsonRecordList(computeNodeId, `${projectDir}/.claude/settings.json`);
  }

  /** Create a record list for a project's .claude/settings.local.json. */
  static forLocal(computeNodeId: string, projectDir: string): ClaudeSettingsJsonRecordList {
    return new ClaudeSettingsJsonRecordList(computeNodeId, `${projectDir}/.claude/settings.local.json`);
  }
}

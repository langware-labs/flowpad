/**
 * ClaudeSettingsFsRecord — the root settings record extracted from ~/.claude.json.
 * Contains identity, onboarding, counters, migration flags, caches, etc.
 * Read-only — the CLI writes this file, we only read.
 */
import { FsRecord, type FsRecordData } from '../../fs-record';
import { RecordType } from '../../record-types';
import { StorageLayout } from '../../storage-layout';
import { fsRecordTypeRegistry } from '../../record-type-registry';

export class ClaudeSettingsFsRecord extends FsRecord {
  static override _recordType = RecordType.CLAUDE_SETTINGS_BASE;
  static override _readOnly = true;
  static override _storageLayout = StorageLayout.FILE;

  // ── Identity ─────────────────────────────────────────
  primaryApiKey?: string;
  hasCompletedOnboarding = false;
  hasCompletedProjectOnboarding = false;

  // ── Onboarding / first-run flags ─────────────────────
  hasAcknowledgedCostThreshold = false;
  hasSeenWelcome = false;
  hasSeenSlashCommands = false;
  hasSeenMcpIntro = false;
  hasSeenCompactMessageTip = false;
  hasSeenProjectInit = false;

  // ── Usage counters ───────────────────────────────────
  numRequests = 0;
  numMessages = 0;
  numSessions = 0;
  numConversations = 0;
  numProjects = 0;

  // ── Migration / version flags ────────────────────────
  lastMigrationVersion?: string;
  schemaVersion?: number;
  lastKnownClaudeVersion?: string;
  lastUpdateCheckTimestamp?: number;

  // ── Caches / ephemeral state ─────────────────────────
  lastActiveProject?: string;
  lastActiveModel?: string;
  preferredModel?: string;
  theme?: string;
  verboseMode = false;

  // ── Feature flags ────────────────────────────────────
  enableTelemetry = true;
  enableCrashReporting = true;
  enableAutoUpdates = true;

  constructor(data?: Partial<FsRecordData>) {
    super(data);
  }
}

fsRecordTypeRegistry.register(ClaudeSettingsFsRecord._recordType, ClaudeSettingsFsRecord as any);

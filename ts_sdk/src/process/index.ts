/**
 * AgenticProcess Module
 *
 * Provides client-side support for managing AgenticProcess entities.
 * AgenticProcess is an APIEntity subclass that receives entity notifications
 * from the backend via WebSocket.
 */

// Shared types (canonical source - breaks circular dependency)
export {
  ProcessStatus,
  WorkerStatus,
  WorkerMode,
  WorkerModelTier,
  parseUIUri,
  isProcessRunning,
  isProcessActive,
  isProcessStartable,
  isWorkerRunning,
  isWorkerTerminal,
  hasWorkerStarted,
  isReadyForInput,
  isBusy,
  getDisplayStatus,
  getWorkerMode,
  ExecutionMode,
  ERROR_WORKER_STATUSES,
  WORKER_BUSY_STATUSES,
  classifyExecutionMode,
  supportedExecutionModes,
} from './agentic-types';
export type { ParsedUIUri, ProcessIconKey, UIComponentPayload, StatusBearingProcess, WorkerType } from './agentic-types';
export { WORKER_STATUS_LABEL, PROCESS_STATUS_LABEL } from './status-labels';

export { AgenticProcess, AgenticProcessEventName } from './agentic-process';
export type {
  AgenticProcessReportEventResult,
  IAgenticProcess,
  MarkdownDoc,
  ProcessState,
  SpawnResult,
} from './agentic-process';
export { ProcessCounters, parseStatusReport } from './process-status-report';
export type { ProcessStatusReport, ProcessCountersData, FocusedAsset } from './process-status-report';
export { ProcessKind, ProcessType } from './process-types';
export type { AssetDescriptor, AssetSource, AssetUsage, AssetUsageKind } from './asset-descriptor';
export {
  ASSET_SOURCE_LABEL,
  READONLY_ASSET_SOURCES,
  WRITABLE_ASSET_SOURCES,
  assetDescriptorHasUsage,
  assetSourceLabel,
  isReadOnlySource,
} from './asset-descriptor';

export { serializeAgenticContext } from './agentic-context';
export type { AgenticContext, PermissionMode, IAgenticProcessOptions, ISpawnWorkerOptions } from './agentic-context';
export {
  launchWizard,
  setWizardLauncher,
  awaitWizardResult,
  completeWizard,
  normalizeWizardResult,
  buildWizardPrompt,
} from './wizard';
export type {
  WizardData,
  WizardLaunchContext,
  WizardLaunchRequest,
  WizardLauncher,
  WizardProcessResult,
  WizardStatus,
} from './wizard';

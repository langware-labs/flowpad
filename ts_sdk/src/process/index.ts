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
} from './agentic-types';
export type { ParsedUIUri, ProcessIconKey, UIComponentPayload, StatusBearingProcess } from './agentic-types';

export { AgenticProcess, AgenticProcessEventName } from './agentic-process';
export type {
  AgenticProcessReportEventResult,
  IAgenticProcess,
  ProcessState,
  ExecuteOptions,
  SpawnResult,
} from './agentic-process';
export { ProcessType } from './process-types';
export type { AssetDescriptor, AssetSource } from './asset-descriptor';
export { ASSET_SOURCE_LABEL, READONLY_ASSET_SOURCES, isReadOnlySource } from './asset-descriptor';

export { serializeAgenticContext } from './agentic-context';
export type { AgenticContext, PermissionMode, IAgenticProcessOptions, ISpawnWorkerOptions } from './agentic-context';

export { extractUIPayload, isUIFlowData, UIHandler } from './ui-handler';
export type { UIComponent } from './ui-handler';

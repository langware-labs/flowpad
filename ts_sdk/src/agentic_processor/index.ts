/**
 * AgenticProcess Module
 *
 * Provides client-side support for managing AgenticProcess entities.
 * AgenticProcess is an APIEntity subclass that receives entity notifications
 * from the backend via WebSocket.
 */

// Shared types (canonical source - breaks circular dependency)
export { ProcessorStatus, parseUIUri, isProcessorRunning, isProcessorBusy, isProcessorIdle, isProcessorTerminal } from './agentic-types';
export type { ParsedUIUri, UIComponentPayload } from './agentic-types';

export { AgenticProcess } from './agentic-process';
export type { IAgenticProcess, ProcessState, ExecuteOptions, SpawnResult } from './agentic-process';

export { serializeAgenticContext } from './agentic-context';
export type { AgenticContext, PermissionMode, IAgenticProcessOptions, ISpawnWorkerOptions } from './agentic-context';

export { extractUIPayload, isUIFlowData, UIHandler } from './ui-handler';
export type { UIComponent } from './ui-handler';

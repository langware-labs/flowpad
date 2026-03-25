/**
 * AgenticProcessor Module
 *
 * Provides client-side support for executing MDO (Markdown Directive Object)
 * instructions via the AgenticProcessor entity.
 *
 * AgenticProcessor and AgenticProcess are APIEntity subclasses that receive
 * entity notifications from the backend via WebSocket. The backend uses
 * notifyEntity to push FlowData and state updates to the frontend.
 */

// Shared types (canonical source - breaks circular dependency)
export { ProcessorStatus, parseUIUri } from './agentic-types';
export type { ProcessorState, DebugState, ParsedUIUri, StackFrame, UIComponentPayload } from './agentic-types';

export { AgenticProcessor } from './agentic-processor';
export type { IAgenticProcessor, CreateProcessOptions } from './agentic-processor';

export { AgenticProcess } from './agentic-process';
export type { IAgenticProcess, ProcessState, ExecuteOptions, SpawnResult } from './agentic-process';

export { serializeAgenticContext } from './agentic-context';
export type { AgenticContext, PermissionMode, IAgenticProcessOptions, ISpawnWorkerOptions } from './agentic-context';

export { extractUIPayload, isUIFlowData, UIHandler } from './ui-handler';
export type { UIComponent } from './ui-handler';

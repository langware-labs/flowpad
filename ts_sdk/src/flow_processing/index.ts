// Core processor classes
export { FlowData, FlowDataSource, FlowDataType } from './flow-data';
export type { IFlowData } from './flow-data';
export { FlowDataFactory } from '../entities/flow/flow-data-factory';
export { FlowStreamProcessor } from './flow-stream-processor';
export { GroupChannelKey } from './group-channel-key';
export { ShellCommandProcessor } from './shell-cmd-processor';
export type { ShellCmdProgress } from './shell-cmd-processor';

// Element types enum
export { FlowElementTypes, isFlowElementType, normalizeElementType } from './flow-element-types';
export type { FlowElementType } from './flow-element-types';

// Event constants and utilities
export { FlowDataEvents, FlowEvents } from './flow-events';
export type { FlowDataChunk } from './flow-events';

// Parser utilities
export { decodeXMLEntities, KeyGenerator, parseAttributes, waitForChunks } from './xml-utilities';

// Specialized FlowData types
export { ShellCmdFlowData as ShellInputFlowData } from '../entities/flow/flow-data-types/shell-input';
export type { ShellCmd } from '../entities/flow/flow-data-types/shell-input';
export { ShellOutputFlowData } from '../entities/flow/flow-data-types/shell-output';
export type { ShellResult } from '../entities/flow/flow-data-types/shell-output';
export { StateFlowData } from '../entities/flow/flow-data-types/state-message';

// FlowDataStream
export { FlowDataStream } from './flow-data-stream';

// FlowDataStreamReader for JSONL testing
export { FlowDataStreamReader } from './flow-data-stream-reader';

// Export new type-safe enums and types
export { DATA_TYPE_ALIASES, FlowDataAttribute } from './flow-data';

// Export streamable types utilities
export { isStreamableElementType, STREAMABLE_ELEMENT_TYPES } from './flow-element-types';

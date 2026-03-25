// Main component
export { AMDEditor } from './AMDEditor';

// Context
export { AMDEditorProvider, useAMDEditor, wrapElement } from './AMDEditorContext';
export type { AMDMetadata, InstructionStatus } from './AMDEditorContext';

// Types
export * from './types';

// Hooks
export { useElementOperations } from './hooks/useElementOperations';

// Utils
export * from './utils/elementFactory';

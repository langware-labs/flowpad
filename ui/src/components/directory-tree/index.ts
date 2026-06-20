export { DirectoryTree } from './DirectoryTree';
export { FilterDropdown } from './FilterDropdown';
export { ProjectsDirectoryTree } from './ProjectsDirectoryTree';
export { useDirectoryTree } from './useDirectoryTree';
export type {
  DirectoryTreeEvents,
  DirectoryTreeHandle,
  DirectoryTreeProps,
  DirectoryTreeState,
  FilterDefinition,
  RootEntity,
  TreeAction,
  TreeActionHandler,
  TreeNode,
} from './types';
export type { ProjectsDirectoryTreeProps } from './ProjectsDirectoryTree';

// Re-export FSItem from SDK for convenience
export type { FSItem } from '@sdk';

// Export ItemHandler class and types
export { ItemHandler } from './ItemHandler';
export type { ItemAction, ItemHandlerOptions, SelectionStyle } from './ItemHandler';

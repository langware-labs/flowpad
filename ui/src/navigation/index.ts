/**
 * Navigation module - Dock-based URL routing for FlowPad
 *
 * Core principle: URL-first architecture
 * - All navigation actions update URL
 * - URL changes trigger store updates
 * - URL is single source of truth for navigation state
 *
 * Usage:
 * ```tsx
 * import { useDockNavigation } from '@src/navigation';
 *
 * function MyComponent() {
 *   const { navigation } = useDockNavigation();
 *
 *   // Shortcut methods
 *   navigation.openTab(ViewType.SHELL);
 *   navigation.openFile('/src/main.ts', { line: 42 });
 *   navigation.openEditor('/src/main.ts');
 *   navigation.openDiff('checkpoint-hash');
 *
 *   // Core method (all shortcuts call this)
 *   const pointer = DockPointer.forTab(ViewType.EDITOR);
 *   navigation.openDock(pointer);
 * }
 * ```
 */

// Core classes
export { DockPointer } from './DockPointer';
export { NavigationActions } from './NavigationActions';

// Hooks
export { useDockNavigation, useCurrentDock } from './useDockNavigation';
export { useSideWindows, type SideWindowsController } from './useSideWindows';

// Types
export type { FileOptions, TabOptions } from './types';

// Constants
export { DOCK_KEYWORD, VIEW_SLOTS } from '../types/ViewType';
export type { ViewSlot } from '../types/ViewType';

// Utilities (for advanced use cases)
export {
  buildDockUrl,
  buildShellRedirectUrl,
  detectLayout,
  parseBasePath,
  parseDockUrl,
  parseQueryParams,
  preserveWindowLayout,
  stripDockPortion,
} from './url-builder';
export type { ParsedBasePath, ParsedDockUrl } from './url-builder';
export { isValidView, isValidViewSlot } from './validators';

// Error handling
export { NavigationError, NavigationErrorType } from './NavigationError';

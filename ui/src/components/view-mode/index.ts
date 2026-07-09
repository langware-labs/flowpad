/**
 * View-mode toolkit — the single import surface for Standard/Advanced/Dev "skin"
 * gating across the app. See docs/viewmodes.md for the methodology.
 *
 *   import { AdvancedOnly, DevOnly, ViewSwap, useIsAdvanced, useIsDev } from '@src/components/view-mode';
 */
export { AdvancedOnly } from './AdvancedOnly';
export { DevOnly } from './DevOnly';
export { ViewSwap } from './ViewSwap';
export { VibeSwap } from './VibeSwap';

// Re-export the global flag API (state lives in contexts/)
// so consumers have one place to import from.
export {
  ViewMode,
  useViewMode,
  useIsAdvanced,
  useIsDev,
  useIsVibe,
  setViewMode,
  setDev,
  getViewMode,
} from '@src/contexts/view-mode-context';

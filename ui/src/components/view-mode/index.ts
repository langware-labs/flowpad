/**
 * View-mode toolkit — the single import surface for Standard/Advanced "skin"
 * gating across the app. See docs/viewmodes.md for the methodology.
 *
 *   import { AdvancedOnly, ViewSwap, useIsAdvanced } from '@src/components/view-mode';
 */
export { AdvancedOnly } from './AdvancedOnly';
export { ViewSwap } from './ViewSwap';

// Re-export the global flag API (state lives in contexts/, mirroring dev-mode)
// so consumers have one place to import from.
export {
  ViewMode,
  useViewMode,
  useIsAdvanced,
  setViewMode,
  getViewMode,
} from '@src/contexts/view-mode-context';

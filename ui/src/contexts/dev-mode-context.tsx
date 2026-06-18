/**
 * @deprecated Backward-compat shim — dev mode is now part of the view-mode hierarchy.
 * All consumers should import from '@src/components/view-mode' for new code.
 */
import { useIsDev } from '@src/contexts/view-mode-context';

export function useDevMode(): boolean {
  return useIsDev();
}

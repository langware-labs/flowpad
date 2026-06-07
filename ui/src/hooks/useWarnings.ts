import {
  createCloudDisconnectedWarning,
  createNoComputeNodeWarning,
  dataContext,
  UserWarning,
} from '@sdk';
import { useCallback, useEffect, useMemo } from 'react';
import { useContext } from './useContext';

/**
 * Hook that manages user warnings based on current context state.
 * Automatically computes and updates warnings for:
 * - Cloud disconnected (in desktop mode when cloud login is not available)
 */
export function useWarnings() {
  const context = useContext();
  const { isDesktop, cloudLoginAvailable, computeNode } = context;

  // Compute warnings based on current state
  const computedWarnings = useMemo(() => {
    const warnings: UserWarning[] = [];

    // Only show warnings in desktop mode
    if (!isDesktop) {
      return warnings;
    }

    // Cloud disconnected warning
    if (!cloudLoginAvailable) {
      warnings.push(createCloudDisconnectedWarning());
    }

    // No compute node warning
    if (!computeNode) {
      warnings.push(createNoComputeNodeWarning());
    }

    return warnings;
  }, [isDesktop, cloudLoginAvailable, computeNode]);

  // Update context warnings when computed warnings change
  useEffect(() => {
    dataContext.setWarnings(computedWarnings);
  }, [computedWarnings]);

  // Helper to remove a specific warning
  const dismissWarning = useCallback((warningId: string) => {
    dataContext.removeWarning(warningId);
  }, []);

  return {
    warnings: context.warnings,
    dismissWarning,
  };
}

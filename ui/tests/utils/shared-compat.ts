/**
 * Shared compatibility module.
 *
 * This module re-exports symbols that were previously imported from
 * @your-org/flowpad-shared. It serves as a single alias target so that
 * vi.mock('@shared-compat', ...) calls in migrated tests work correctly.
 *
 * The re-exports map to their resolved locations in either @sdk or @src.
 */

// Re-export @tanstack/react-query (shared lib re-exported these)
export { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';

// Re-export zustand (shared lib re-exported these)
export { create } from 'zustand';

// Re-export hooks from SDK (via minihub re-exports)
export {
  useProcess,
  useProcessActions,
  useProcessExecution,
  useProcessStateField,
  useProcessStream,
  useProcessStreamingArtifacts,
  useCurrentArtifacts,
  useStateChatOptions,
  useEntityData,
} from '@src/hooks/flow-hooks';

export { useEntitiesQuery } from '@src/hooks/entity-hooks';

export { useContext } from '@src/hooks/useContext';
export { useFS } from '@src/hooks/useFS';
export { useWarnings } from '@src/hooks/useWarnings';

// Re-export UI components
export { TooltipProvider } from '@src/components/ui/tooltip';

// Re-export navigation
export { DockPointer } from '@src/navigation/DockPointer';

// Re-export lib utilities
export { cn } from '@src/lib/utils';

// Re-export hooks that may exist
export { useProject } from '@src/hooks/useProject';
export { useToast } from '@src/hooks/use-toast';

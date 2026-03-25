import { useCallback, useSyncExternalStore } from 'react';
import { AgenticProcess } from '@sdk';

/**
 * Registry of active planning processes.
 * Maps skill path to the AgenticProcess running the planner.
 *
 * This is a module-level singleton - shared across all component instances.
 */
const activeProcesses = new Map<string, AgenticProcess>();

/**
 * Listeners that get notified when the registry changes.
 */
const listeners = new Set<() => void>();

/**
 * Notify all listeners of a change.
 */
function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Register a planning process for a skill path.
 * Called from HomeLanding when starting a new planning session.
 *
 * @param skillPath - The skill path (e.g., "user-skills/my-session")
 * @param process - The AgenticProcess running the planner
 */
export function registerPlanningProcess(skillPath: string, process: AgenticProcess): void {
  // Cleanup any existing process for this path (just remove from registry)
  const existing = activeProcesses.get(skillPath);
  if (existing) {
    activeProcesses.delete(skillPath);
  }

  activeProcesses.set(skillPath, process);
  emitChange();

  // Note: We intentionally do NOT auto-unregister on 'complete' here.
  // The SkillEditor's completion handler needs to extract FlowData content first,
  // then it calls unregisterPlanningProcess() explicitly after saving.
  // We only auto-unregister on error to cleanup failed processes.
  process.on('error', () => {
    if (activeProcesses.get(skillPath) === process) {
      activeProcesses.delete(skillPath);
      emitChange();
    }
  });
}

/**
 * Unregister a planning process for a skill path.
 * Can be called manually to cleanup early.
 *
 * @param skillPath - The skill path to unregister
 */
export function unregisterPlanningProcess(skillPath: string): void {
  const process = activeProcesses.get(skillPath);
  if (process) {
    activeProcesses.delete(skillPath);
    emitChange();
  }
}

/**
 * Get a snapshot of the process for a given skill path.
 * Used internally by the hook.
 */
function getProcessSnapshot(skillPath: string | null): AgenticProcess | null {
  if (!skillPath) return null;
  return activeProcesses.get(skillPath) || null;
}

/**
 * Hook for subscribing to active planning process for a skill path.
 * Uses useSyncExternalStore for optimal React 18+ integration.
 *
 * @param skillPath - The skill path to track (e.g., "user-skills/my-session")
 * @returns The active AgenticProcess if one exists, null otherwise
 *
 * @example
 * ```tsx
 * const activeProcess = useActivePlanningProcess('user-skills/my-session');
 *
 * if (activeProcess) {
 *   return <AgenticProgressViewer process={activeProcess} />;
 * }
 * ```
 */
export function useActivePlanningProcess(skillPath: string | null): AgenticProcess | null {
  const subscribe = useCallback((callback: () => void) => {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  }, []);

  const getSnapshot = useCallback(() => {
    return getProcessSnapshot(skillPath);
  }, [skillPath]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Check if there's an active planning process for a skill path.
 * Useful for conditional rendering without subscribing to updates.
 *
 * @param skillPath - The skill path to check
 * @returns true if there's an active process
 */
export function hasActivePlanningProcess(skillPath: string): boolean {
  return activeProcesses.has(skillPath);
}

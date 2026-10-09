import { SubAgent, AgenticProcess, ComputeNode, dataContext, Project, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { useMemo } from 'react';
import { useOutletContext } from 'react-router';
import { DockPointer } from '@src/navigation/DockPointer';
import { useCurrentDock } from '@src/navigation/useDockNavigation';

/**
 * Context passed from AgentLayout to child routes via React Router's Outlet
 *
 * This interface defines the shape of the context that AgentLayout provides
 * to all child routes through the Outlet component. Child components can access
 * this context using the useAgentContext hook.
 *
 * @example
 * ```typescript
 * // In a child route component:
 * const { agent, flow, computeNode, project } = useAgentContext();
 * ```
 */
export interface AgentContext {
  /** The current agent instance, or null/undefined if not loaded */
  agent: SubAgent | null | undefined;
  /** The current agentic process instance, or null/undefined if not loaded */
  flow: AgenticProcess | null | undefined;
  /**
   * The current agentic process's id, read from the URL — known on the first
   * render, before `flow` loads. Prefer it when the id is all you need: waiting
   * for `flow` means rendering once without a process and again with one.
   */
  flowId: string | null;
  /** The compute node for executing commands, or null/undefined if not available */
  computeNode: ComputeNode | null | undefined;
  /** The current project instance, or null/undefined if not loaded */
  project: Project | null | undefined;
}

/**
 * The agentic process the URL is about: the host whose display shows this dock
 * (`/process/<typeid>/display/…` or `?host=`), else the process's own shell dock.
 */
function processIdFromDock(dock: DockPointer | null): string | null {
  const typeId = dock?.hostProcessId ?? (DockPointer.isAgenticProcessPointer(dock?.pointer) ? dock?.pointer : null);
  return typeId ? DockPointer.extractAgenticProcessId(typeId) : null;
}

export const useAgentContext = (): AgentContext => {
  const outletContext = useOutletContext<AgentContext>(); // Get outlet-specific values

  // The process comes from the URL, never from dataContext: the global is not
  // reactive, so a view that rendered before it was set kept no process forever.
  const flowId = processIdFromDock(useCurrentDock());
  const flowTypeId = useMemo(() => (flowId ? new TypeId(AgenticProcess.type, flowId) : null), [flowId]);
  const { data: flowFromUrl } = useEntity<AgenticProcess>(flowTypeId);

  // Derive agent from activeEntity when activeEntity is a SubAgent type
  // Note: dataContext is a global singleton and doesn't trigger re-renders
  const agentFromContext =
    dataContext.activeEntity && SubAgent.isType(dataContext.activeEntity) ? dataContext.activeEntity : null;

  // Merge: outlet context takes precedence, fallback to dataContext
  return {
    agent: outletContext?.agent ?? agentFromContext ?? null,
    flow: outletContext?.flow ?? flowFromUrl ?? null,
    flowId: outletContext?.flow?.id ?? flowId,
    computeNode: outletContext?.computeNode ?? dataContext.computeNode ?? null,
    project: outletContext?.project ?? dataContext.project ?? null,
  };
};

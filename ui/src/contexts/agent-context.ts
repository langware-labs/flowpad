import { SubAgent, AgenticProcess, ComputeNode, dataContext, Project } from '@sdk';
import { useOutletContext } from 'react-router';

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
  /** The compute node for executing commands, or null/undefined if not available */
  computeNode: ComputeNode | null | undefined;
  /** The current project instance, or null/undefined if not loaded */
  project: Project | null | undefined;
}

export const useAgentContext = (): AgentContext => {
  const outletContext = useOutletContext<AgentContext>(); // Get outlet-specific values

  // Derive agent from activeEntity when activeEntity is a SubAgent type
  // Note: dataContext is a global singleton and doesn't trigger re-renders
  const agentFromContext =
    dataContext.activeEntity && SubAgent.isType(dataContext.activeEntity) ? dataContext.activeEntity : null;

  // Merge: outlet context takes precedence, fallback to dataContext
  return {
    agent: outletContext?.agent ?? agentFromContext ?? null,
    flow: outletContext?.flow ?? dataContext.agenticProcess ?? null,
    computeNode: outletContext?.computeNode ?? dataContext.computeNode ?? null,
    project: outletContext?.project ?? dataContext.project ?? null,
  };
};

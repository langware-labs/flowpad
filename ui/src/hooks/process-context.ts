/**
 * Shared validation helpers for agentic process workflows.
 */
import { dataContext, type TypeId } from '@sdk';
import { notify } from '@src/notifications';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidatedContext {
  computeNode: NonNullable<typeof dataContext.computeNode>;
  computeNodeTypeId: TypeId;
  homePath: string;
  projectTypeId: TypeId | undefined;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function validateProcessContext(): ValidatedContext | null {
  const computeNode = dataContext.computeNode;
  if (!computeNode?.typeId) {
    notify.error({ title: 'Compute node unavailable', message: 'No compute node is available.' });
    return null;
  }

  const homePath = dataContext.bootstrapInfo?.desktop_info?.paths?.home;
  if (!homePath) {
    notify.error({ title: 'Missing paths', message: 'Home path is unavailable.' });
    return null;
  }

  return { computeNode, computeNodeTypeId: computeNode.typeId, homePath, projectTypeId: undefined };
}

/**
 * Shared validation helpers for agentic process workflows.
 */
import { dataContext, type TypeId } from '@sdk';

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

export function validateProcessContext(
  toast: (opts: { title: string; description: string; variant: string }) => void,
): ValidatedContext | null {
  const computeNode = dataContext.computeNode;
  if (!computeNode?.typeId) {
    toast({
      title: 'Compute node unavailable',
      description: 'No compute node is available.',
      variant: 'destructive',
    });
    return null;
  }

  const homePath = dataContext.bootstrapInfo?.desktop_info?.paths?.home;
  if (!homePath) {
    toast({ title: 'Missing paths', description: 'Home path is unavailable.', variant: 'destructive' });
    return null;
  }

  return { computeNode, computeNodeTypeId: computeNode.typeId, homePath, projectTypeId: undefined };
}

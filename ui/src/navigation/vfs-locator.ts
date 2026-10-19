import { ComputeProviderType, TypeId } from '@sdk';
import { LOCAL_COMPUTE_NODE } from './asset-doc-types';

export interface ComputeNodeLocatorLike {
  id?: string | null;
  type?: string | null;
  name?: string | null;
  uname?: string | null;
  node_provider_type?: ComputeProviderType | null;
}

/**
 * Stable VFS locator for a live compute node.
 *
 * Local nodes always serialize as `compute_node-@local`; their runtime UUID is
 * reserved for I/O. Remote nodes retain the UUID that identifies their VFS.
 */
export function vfsLocatorForComputeNode(node: ComputeNodeLocatorLike | null | undefined): TypeId | null {
  if (!node?.id || !node.type) return null;
  if (
    node.id === LOCAL_COMPUTE_NODE.id ||
    node.name === LOCAL_COMPUTE_NODE.id ||
    node.uname === 'local' ||
    node.node_provider_type === ComputeProviderType.LOCAL_MACHINE
  ) {
    return LOCAL_COMPUTE_NODE;
  }
  return new TypeId(node.type, node.id);
}

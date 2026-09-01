export { AssetManagerButton } from './AssetManagerButton';
export { AssetManagerPopover } from './AssetManagerPopover';
export { useProcessAssets } from './useProcessAssets';

// The row and the pieces needed to build its props, for surfaces that want the
// asset list WITHOUT the popover's chrome (search box, type bar, overlay) —
// the agent-resources navigator renders these inline in its own sections.
// Exported through the barrel rather than deep-imported so the module keeps one
// public face.
export { AssetRow } from './AssetManagerPopover';
export { assetScope, AssetScopeChip, type AssetScope, type AssetScopeKind } from './asset-scope';
// `displayLabelForDescriptor`, not the typeid form: it threads the descriptor's
// on-disk `name` fallback, without which a not-yet-indexed asset renders as a
// raw `skill-<uuid>`.
export { displayLabelForDescriptor, descriptorKey, basename } from './asset-row-helpers';

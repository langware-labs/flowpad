export { AssetManagerButton } from './AssetManagerButton';
export { AssetManagerPopover } from './AssetManagerPopover';
export { useProcessAssets, type UseProcessAssetsResult } from './useProcessAssets';

export { AssetRow } from './AssetManagerPopover';
export { assetScope } from './asset-scope';

// Label helpers for surfaces that list descriptors outside the popover.
// `displayLabelForDescriptor`, not the typeid form: it threads the descriptor's
// on-disk `name` fallback, without which a not-yet-indexed asset renders as a
// raw `skill-<uuid>`.
export { displayLabelForDescriptor, descriptorKey, basename } from './asset-row-helpers';

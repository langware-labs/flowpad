/**
 * Icons — one resolver, one renderer, one hook.
 *
 * The backend names a glyph and the frontend resolves the name; this module is
 * that resolution, in one place, for every consumer. `resolveIcon` is pure and
 * framework-free, `iconElement` renders without React, and `useIcon`
 * (`../react/hooks/useIcon`) is a thin wrapper over both for components.
 */
export { ICON_CSS, ICON_STYLE_ID, ensureIconStyles, iconChip, iconElement, iconElementFor, resolveForRender, withRole } from './element';
export type { IconChipOptions, IconElementOptions } from './element';
export { fetchIconPacks, getIconFallback, getIconPacks, loadIconPacks, onIconPacksChanged, resolve, setIconFallback } from './registry';
export { iconTag, kebab, resolveIcon } from './resolve';
export type { IconPackSpec, IconResolution, IconSpec } from './types';
export { bundleIcon, bundleRenderer, registerBundleRenderer } from './bundle';
export type { BundleIcon, BundleRenderer } from './bundle';

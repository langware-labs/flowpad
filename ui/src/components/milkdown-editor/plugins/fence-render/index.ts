/**
 * Public entry: spread `fenceRenderPlugins` into the Milkdown plugin list AFTER
 * the commonmark preset, so the `code_block` NodeView registers against the
 * preset's own schema. Adds:
 *
 *   - a registry of fence languages that render as something other than code
 *   - per-block Render | Code tab state (plugin-owned, remapped across edits)
 *   - a `code_block` NodeView hosting the tab strip, the rendered output, and
 *     the source pane
 *
 * Nothing here touches the schema, the parser, or the serializer. A NodeView is
 * render-only, so markdown output is byte-identical to not having this plugin
 * at all — and unlike a `$nodeSchema` override it can't trip the
 * double-override crash documented in `../bidi/schema.ts`.
 *
 * `prism` stays in the chain alongside this: it highlights the source pane of
 * these fences and every language without a renderer.
 *
 * Deliberately renderer-agnostic: concrete renderers self-register at their own
 * module scope, and the consumer imports them for that side effect — the same
 * direction `columnRegistry` / `filterRegistry` use. Registering them here would
 * make the generic plugin depend on every implementation of it.
 */

import { $view } from '@milkdown/utils';
import { codeBlockSchema } from '@milkdown/preset-commonmark';
import type { MilkdownPlugin } from '@milkdown/ctx';

import { fenceModePlugin } from './fence-mode';
import { fenceNodeViewConstructor } from './node-view';

export const fenceRenderPlugins: MilkdownPlugin[] = [
  fenceModePlugin,
  $view(codeBlockSchema.node, () => fenceNodeViewConstructor),
];

export { registerFenceRenderer, getFenceRenderer } from './registry';
export type { FenceRenderer, FenceRenderContext, FenceTheme } from './registry';
export { setFenceMode, fenceModeFromDecorations, fenceModeKey } from './fence-mode';
export type { FenceMode } from './fence-mode';

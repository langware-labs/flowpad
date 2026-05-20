/**
 * Public entry: spread `bidiPlugins` into the Milkdown plugin list AFTER
 * the commonmark preset so the extended paragraph/heading schemas replace
 * the originals. Adds:
 *
 *   - `dir` and `align` attrs on paragraph and heading nodes
 *   - A remark transformer that lifts `<p dir>` / `<h* dir>` HTML wrappers
 *     in source markdown into those attrs
 *   - A `toMarkdown` writer that emits the HTML wrappers back when the attrs
 *     are non-default (default-attr nodes round-trip byte-identical)
 *
 * No UI here — the toolbar buttons + commands arrive in later phases.
 */

import type { MilkdownPlugin } from '@milkdown/ctx';
import { bidiSchemaPlugins } from './schema';
import { bidiRemarkPlugin } from './parser';
import { bidiCommandPlugins } from './commands';
import { bidiEnterInheritPlugin } from './enter-inherit';

export const bidiPlugins: MilkdownPlugin[] = [
  bidiRemarkPlugin,
  ...bidiSchemaPlugins,
  ...bidiCommandPlugins,
  bidiEnterInheritPlugin,
];

export { setDirCommand, unsetDirCommand, setAlignCommand, unsetAlignCommand } from './commands';
export type { BidiDir, BidiAlign } from './commands';

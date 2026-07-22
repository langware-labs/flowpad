/**
 * Extra syntax grammars for the Milkdown code-fence highlighter.
 *
 * `@milkdown/plugin-prism` does NOT use the global `Prism` object — it
 * highlights through its own `refractor` instance (see
 * `@milkdown/plugin-prism/lib/index.js`, `import { refractor } from "refractor"`).
 * That default instance is refractor's *common* bundle: 62 aliases / ~36
 * languages, already covering go, rust, sql, java, php, swift, kotlin, ruby,
 * lua, r, perl, diff and the usual web/scripting set.
 *
 * Anything outside that set renders unhighlighted AND logs
 * `"Unsupported language detected"` once per decoration pass. The list below
 * is the set of info strings this repo's own markdown actually uses that the
 * common bundle lacks.
 *
 * Import specifier note: refractor's export map is `"./*": "./lang/*.js"`, so
 * the path is `refractor/mermaid` — NOT `refractor/lang/mermaid`, which does
 * not resolve.
 *
 * Deliberately NOT `refractor/all` (594 grammars) — keep the bundle honest and
 * add grammars here as the corpus grows.
 */

import type { Refractor } from 'refractor/core';

import applescript from 'refractor/applescript';
import csv from 'refractor/csv';
import http from 'refractor/http';
import mermaid from 'refractor/mermaid';
import powershell from 'refractor/powershell';
import toml from 'refractor/toml';

const EXTRA_LANGUAGES = [applescript, csv, http, mermaid, powershell, toml];

/**
 * Language aliases: `[canonical, ...aliases]`.
 *
 * `interface` is our own rendered fence type (an API/function-signature
 * contract authored in YAML). It has no grammar of its own — pointing it at
 * yaml means the source half of the block is highlighted correctly whenever
 * the caret is inside it.
 */
const LANGUAGE_ALIASES: Record<string, string[]> = {
  yaml: ['interface'],
};

/** Passed to `prismConfig` — mutates the plugin's private refractor instance. */
export function configureRefractor(refractor: Refractor): void {
  for (const language of EXTRA_LANGUAGES) {
    refractor.register(language);
  }
  refractor.alias(LANGUAGE_ALIASES);
}

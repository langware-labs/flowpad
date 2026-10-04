/**
 * Run a ```ts fence from `docs/snippets/*.md` as written — the TS twin of
 * `tests/utils/snippets.py` (`fence_under` + `run_fence`).
 *
 * A doc's TS fence is the code a reader copies, so it must run. `tsFenceUnder`
 * addresses it by heading (like the Python side: inserting a section above does
 * not re-point every pin below), and `runTsFence` executes it:
 *
 * - `import { A, B } from '<module>'` lines bind from the `scope` you pass —
 *   a fence's imports name what it uses, and a missing binding is an error, not
 *   an `undefined` that fails three lines later.
 * - The body is transpiled with esbuild (the one vitest already ships) and runs
 *   as an async function, so top-level `await` works as it does in a module.
 * - Every top-level `const`/`let` comes back in the returned namespace.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transform } from 'esbuild';

const SHELF = resolve(__dirname, '../../../docs/snippets');

const FENCE = /```(\w*)\n([\s\S]*?)```/g;
const HEADING = /^(#{2,6})\s+(.*)$/gm;

/** The markdown with every fence blanked (same length), so a `#` inside code is never a heading. */
function withoutFences(markdown: string): string {
  return markdown.replace(FENCE, (m) => ' '.repeat(m.length));
}

export function snippetDoc(name: string): string {
  return readFileSync(resolve(SHELF, name), 'utf8');
}

/** The `nth` `lang` fence beneath the heading whose text starts with `heading`. */
export function tsFenceUnder(markdown: string, heading: string, { lang = 'ts', nth = 0 } = {}): string {
  const blanked = withoutFences(markdown);
  const headings = [...blanked.matchAll(HEADING)].map((m) => ({ at: m.index ?? 0, text: m[2].trim() }));
  const start = headings.find((h) => h.text.startsWith(heading));
  if (!start) throw new Error(`no heading starting with ${JSON.stringify(heading)}`);
  const end = headings.find((h) => h.at > start.at)?.at ?? markdown.length;
  const found = [...markdown.slice(start.at, end).matchAll(FENCE)].filter((m) => m[1] === lang).map((m) => m[2]);
  if (found.length <= nth) throw new Error(`section ${JSON.stringify(heading)} has ${found.length} ${lang} fence(s), wanted #${nth}`);
  return found[nth];
}

const IMPORT = /^\s*import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"][^'"]+['"];?\s*$/gm;
const DECLARED = /^(?:const|let)\s+([A-Za-z_$][\w$]*)/gm;

/** Execute `source` with `scope` bound; resolves to its top-level declarations. */
export async function runTsFence(source: string, scope: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const imported = [...source.matchAll(IMPORT)].flatMap((m) =>
    m[1]
      .split(',')
      .map((name) => name.replace(/^type\s+/, '').trim())
      .filter(Boolean),
  );
  for (const name of imported) {
    if (!(name in scope)) throw new Error(`the fence imports ${name}, which the test did not provide`);
  }
  const body = source.replace(IMPORT, '');
  const declared = [...new Set([...body.matchAll(DECLARED)].map((m) => m[1]))];
  // Transpiled as the body of an async function (top-level `await`, a trailing `return`), then unwrapped.
  const { code: wrapped } = await transform(
    `async function __fence__() {\n${body}\nreturn { ${declared.join(', ')} };\n}`,
    { loader: 'ts', target: 'es2022' },
  );
  const code = wrapped.slice(wrapped.indexOf('{') + 1, wrapped.lastIndexOf('}'));
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<Record<string, unknown>>;
  const names = Object.keys(scope);
  return new AsyncFunction(...names, code)(...names.map((n) => scope[n]));
}

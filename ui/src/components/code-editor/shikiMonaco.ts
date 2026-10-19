import type { Monaco } from '@monaco-editor/react';
import { shikiToMonaco } from '@shikijs/monaco';
import { createHighlighter, Highlighter } from 'shiki';

/**
 * The one shiki highlighter behind every Monaco in the app.
 *
 * `shikiToMonaco` replaces Monaco's theme registry GLOBALLY: once any editor has
 * run it, only shiki's themes exist and asking for a built-in one (`vs-dark`)
 * throws — which took the whole page down when a second kind of editor used its
 * own theme. So every editor goes through here and uses `monacoTheme`.
 */
let highlighter: Promise<Highlighter> | null = null;
/** Languages already registered with Monaco and wired to shiki. */
const wired = new Set<string>();

export async function ensureShikiMonaco(monaco: Monaco, language: string): Promise<void> {
  highlighter ??= createHighlighter({ themes: ['dark-plus', 'light-plus'], langs: [] });
  const h = await highlighter;
  // Once per language, not once per editor mount: `shikiToMonaco` re-defines both
  // themes (~1000 rules each) and WRAPS `monaco.editor.setTheme`/`create` around the
  // previous wrapper, so mounting N editors left N nested wrappers and N pairs of
  // themes reachable for the life of the page — every later theme switch paying for
  // all of them. `monaco.languages.register` likewise appends a duplicate each time.
  if (wired.has(language)) return;
  try {
    await h.loadLanguage(language as Parameters<Highlighter['loadLanguage']>[0]);
  } catch {
    // A language shiki doesn't ship still edits fine as plain text.
  }
  if (wired.has(language)) return; // another mount got there while we awaited
  wired.add(language);
  monaco.languages.register({ id: language });
  shikiToMonaco(h, monaco);
}

export const monacoTheme = (resolvedTheme: string | undefined) => (resolvedTheme === 'dark' ? 'dark-plus' : 'light-plus');

/** For an editor's `onMount`: load the shared themes, then apply the current one.
 *  Until then Monaco falls back to its default look instead of throwing. */
export function applyShikiTheme(monaco: Monaco, language: string, resolvedTheme: string | undefined): void {
  void ensureShikiMonaco(monaco, language).then(() => monaco.editor.setTheme(monacoTheme(resolvedTheme)));
}

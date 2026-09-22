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

export async function ensureShikiMonaco(monaco: Monaco, language: string): Promise<void> {
  highlighter ??= createHighlighter({ themes: ['dark-plus', 'light-plus'], langs: [] });
  const h = await highlighter;
  try {
    await h.loadLanguage(language as Parameters<Highlighter['loadLanguage']>[0]);
  } catch {
    // A language shiki doesn't ship still edits fine as plain text.
  }
  monaco.languages.register({ id: language });
  shikiToMonaco(h, monaco);
}

export const monacoTheme = (resolvedTheme: string | undefined) => (resolvedTheme === 'dark' ? 'dark-plus' : 'light-plus');

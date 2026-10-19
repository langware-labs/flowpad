/**
 * B8 — a Monaco text model must not outlive the EditorPane that created it.
 *
 * `<Editor>` (@monaco-editor/react) creates one `inmemory://model/N` per mount
 * and disposes it in its own unmount cleanup — by reaching it THROUGH the
 * editor (`editor.getModel()?.dispose()`). EditorPane used to dispose the
 * editor itself in a parent-side effect cleanup, which React runs first; that
 * detached the model without disposing it, so the library's cleanup saw `null`
 * and one model holding the whole file text leaked per unmount (12 views →
 * 12 models / 888k chars in a real browser).
 *
 * Real `EditorPane`, real `@monaco-editor/react`, real `monaco-editor` (the npm
 * build handed to the loader instead of the CDN one). Only the data hooks around
 * the editor are stubbed — none of them touch model or editor lifetime.
 *
 * `DiffContent` keeps its manual dispose on purpose: a disposed DiffEditorWidget
 * still answers `getModel()`, so the library can dispose its model pair, and
 * disposing the widget first is what silences Monaco's "TextModel got disposed
 * before DiffEditorWidget model got reset" error. The second case pins that.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { render, waitFor } from '@testing-library/react';

// The unit tier shares ONE jsdom document across files. Real Monaco keeps
// page-lifetime state on it: listeners on `document.body` / `window` (its WebKit
// clipboard workaround calls `navigator.clipboard.write` on every body click,
// which jsdom lacks — a later file's first click would then throw) and DOM it
// appends to <body>/<head> (`.monaco-aria-container` carries `role="alert"`
// children, so a later file's `findByRole('alert')` finds "multiple elements").
// Record every listener this file adds to the shared targets and every node it
// appends there, remove them at the end, and put back the globals the polyfills
// below overwrite.
type Added = [EventTarget, string, EventListenerOrEventListenerObject | null, boolean | AddEventListenerOptions | undefined];
const added: Added[] = [];
const sharedTargets: EventTarget[] = [window, document, document.body];
const nodesBefore = new Set<Element>([...document.body.children, ...document.head.children]);
const originalAdd = Object.getOwnPropertyDescriptor(EventTarget.prototype, 'addEventListener')!;
EventTarget.prototype.addEventListener = function (this: EventTarget, type, listener, options) {
  if (sharedTargets.includes(this)) added.push([this, type, listener, options]);
  return (originalAdd.value as typeof EventTarget.prototype.addEventListener).call(this, type, listener, options);
};
const globalsBefore = {
  matchMedia: Object.getOwnPropertyDescriptor(window, 'matchMedia'),
  queryCommandSupported: Object.getOwnPropertyDescriptor(document, 'queryCommandSupported'),
  getContext: Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext'),
  CSS: Object.getOwnPropertyDescriptor(globalThis, 'CSS'),
  MonacoEnvironment: Object.getOwnPropertyDescriptor(globalThis, 'MonacoEnvironment'),
};
afterAll(() => {
  Object.defineProperty(EventTarget.prototype, 'addEventListener', originalAdd);
  for (const [target, type, listener, options] of added) target.removeEventListener(type, listener, options);
  for (const el of [...document.body.children, ...document.head.children]) if (!nodesBefore.has(el)) el.remove();
  const put = (owner: object, key: string, d: PropertyDescriptor | undefined) =>
    d ? Object.defineProperty(owner, key, d) : delete (owner as Record<string, unknown>)[key];
  put(window, 'matchMedia', globalsBefore.matchMedia);
  put(document, 'queryCommandSupported', globalsBefore.queryCommandSupported);
  put(HTMLCanvasElement.prototype, 'getContext', globalsBefore.getContext);
  put(globalThis, 'CSS', globalsBefore.CSS);
  put(globalThis, 'MonacoEnvironment', globalsBefore.MonacoEnvironment);
});

// --- jsdom gaps Monaco needs (layout / canvas / CSS) ---
if (!window.matchMedia) {
  (window as any).matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
}
(document as any).queryCommandSupported ??= () => false;
HTMLCanvasElement.prototype.getContext = function () {
  return new Proxy(
    {},
    {
      get: (_t, k) =>
        k === 'measureText'
          ? () => ({ width: 8 })
          : k === 'getImageData' || k === 'createImageData'
            ? (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })
            : typeof k === 'string' && /Ratio$/.test(k)
              ? 1
              : () => {},
      set: () => true,
    },
  );
} as any;
(globalThis as any).CSS ??= {};
(globalThis as any).CSS.escape ??= (v: string) => String(v).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
(globalThis as any).CSS.supports ??= () => false;
(globalThis as any).MonacoEnvironment = {
  getWorker: () => ({ postMessage() {}, terminate() {}, addEventListener() {}, removeEventListener() {} }),
};

const CONTENT: Record<string, string> = {};
vi.mock('@sdk/react/hooks', () => ({
  useContext: () => ({ agenticProcess: null }),
  useProject: () => ({
    project: { typeId: 'project-00000000-0000-4000-8000-000000000000', fs_storage_mount_path: '/tmp/p' },
  }),
}));
vi.mock('@src/hooks/useFS', () => ({
  useFS: () => ({
    content: (p: string) => ({ content: CONTENT[p] ?? '', isDirty: false }),
    download: async () => {},
    getDownloadUrl: () => '',
    subscribe: () => () => {},
  }),
}));
vi.mock('@src/components/code-editor/shikiMonaco', () => ({
  ensureShikiMonaco: async () => {},
  monacoTheme: () => 'vs',
}));
vi.mock('@src/components/milkdown-editor/MilkdownEditor', () => ({ MilkdownEditor: () => null }));
vi.mock('@src/components/code-editor/SnippetView', () => ({ SnippetView: () => null }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));

let monaco: typeof import('monaco-editor');
let EditorPane: typeof import('@src/components/code-editor/EditorPane').EditorPane;
let DiffContent: typeof import('@src/components/code-editor/DiffContent').DiffContent;

beforeAll(async () => {
  monaco = await import('monaco-editor/esm/vs/editor/editor.api');
  const { loader } = await import('@monaco-editor/react');
  loader.config({ monaco });
  ({ EditorPane } = await import('@src/components/code-editor/EditorPane'));
  ({ DiffContent } = await import('@src/components/code-editor/DiffContent'));
});

const census = () => {
  const models = monaco.editor.getModels();
  return {
    models: models.length,
    chars: models.reduce((n, m) => n + m.getValueLength(), 0),
    editors: monaco.editor.getEditors().length,
    diffEditors: monaco.editor.getDiffEditors().length,
  };
};

describe('EditorPane model lifetime (B8)', () => {
  it('disposes the model on unmount — same file twice, then another file', async () => {
    const base = census();
    const files = ['/src/a.py', '/src/a.py', '/src/b.py'];
    for (const path of files) {
      CONTENT[path] = `# ${path}\n` + 'x = 1  # padding\n'.repeat(1500);
      const view = render(<EditorPane file={{ path, language: 'python' }} readOnly />);
      await waitFor(() => expect(monaco.editor.getEditors().length).toBe(base.editors + 1));
      await waitFor(() => expect(monaco.editor.getEditors().at(-1)!.getValue().length).toBeGreaterThan(20000));
      expect(census().models).toBe(base.models + 1);
      view.unmount();
      // The bound: nothing left behind, neither the editor nor its model.
      expect(census()).toEqual(base);
    }
  });

  it('DiffContent keeps its models flat and throws no dispose-order error', async () => {
    const diff = [
      'diff --git a/a.py b/a.py',
      'index 111..222 100644',
      '--- a/a.py',
      '+++ b/a.py',
      '@@ -1,3 +1,3 @@',
      ' keep',
      '-old one',
      '+new one',
      ' keep',
      '@@ -20,3 +20,3 @@',
      ' keep',
      '-old two',
      '+new two',
      ' keep',
      '',
    ].join('\n');
    const base = census();
    const unexpected: unknown[] = [];
    const onError = (e: ErrorEvent) => unexpected.push(e.error ?? e.message);
    window.addEventListener('error', onError);
    try {
      for (let i = 0; i < 2; i++) {
        const view = render(<DiffContent diffString={diff} />);
        await waitFor(() => expect(monaco.editor.getDiffEditors().length).toBe(base.diffEditors + 2));
        await waitFor(() =>
          expect(monaco.editor.getDiffEditors().every((d) => d.getModel()?.modified.getValueLength())).toBe(true),
        );
        view.unmount();
        // Monaco reports the dispose-order error through a `setTimeout` rethrow.
        await new Promise((r) => setTimeout(r, 0));
        expect(census()).toEqual(base);
      }
    } finally {
      window.removeEventListener('error', onError);
    }
    expect(unexpected).toEqual([]);
  });
});

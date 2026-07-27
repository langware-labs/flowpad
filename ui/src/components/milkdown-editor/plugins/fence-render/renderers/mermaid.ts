/**
 * ```mermaid fences render as diagrams.
 *
 * The whiteboard editor already writes these blocks into markdown documents
 * (`WhiteboardAssetEditor.tsx` → `spliceMermaidBlock`), so this closes a loop
 * the app was already half-way through.
 *
 * `mermaid` is a direct dependency but a heavy one — loaded lazily through a
 * module-level cached import, matching how `WhiteboardAssetEditor` pulls in
 * `@excalidraw/mermaid-to-excalidraw`.
 */

import { registerFenceRenderer, type FenceRenderContext, type FenceRenderer } from '../registry';

type MermaidModule = typeof import('mermaid')['default'];

let mermaidPromise: Promise<MermaidModule> | null = null;
let initializedTheme: string | null = null;
let renderAttempt = 0;

async function loadMermaid(theme: FenceRenderContext['theme']): Promise<MermaidModule> {
  mermaidPromise ??= import('mermaid').then((mod) => mod.default);
  const mermaid = await mermaidPromise;

  const mermaidTheme = theme === 'light' ? 'default' : 'dark';
  if (initializedTheme !== mermaidTheme) {
    mermaid.initialize({
      startOnLoad: false,
      theme: mermaidTheme,
      // Mermaid otherwise paints its own red "Syntax error" graphic into the
      // container on a parse failure. We want the throw so the NodeView can
      // keep the last good diagram and show an error chip instead.
      suppressErrorRendering: true,
    });
    initializedTheme = mermaidTheme;
  }
  return mermaid;
}

export const mermaidRenderer: FenceRenderer = {
  language: 'mermaid',
  tabLabel: 'Diagram',

  async render(code, host, ctx) {
    const trimmed = code.trim();
    if (!trimmed) {
      host.textContent = '';
      return;
    }

    const mermaid = await loadMermaid(ctx.theme);
    // The id must be unique PER ATTEMPT, not per block. Mermaid stamps it onto
    // the returned `<svg>`, and on a later parse failure its cleanup removes
    // whatever element currently matches that id — which, with a stable id, is
    // the previously committed diagram sitting in the document. Reusing the id
    // therefore wipes the last good render the moment the user mistypes, which
    // is exactly the flash-to-blank this renderer is supposed to avoid.
    // Mermaid removes its own temporary nodes, so unique ids leak nothing.
    const { svg } = await mermaid.render(`${ctx.blockId}-${++renderAttempt}`, trimmed);
    // Mermaid sanitizes its own output (DOMPurify) at the default
    // securityLevel, so this is the sanitized string, not raw user HTML.
    host.innerHTML = svg;
  },
};

registerFenceRenderer(mermaidRenderer);

import type { Chart, FSRef } from '@sdk';
import { writeChartMermaid, autoNote } from './chartDoc';
import { excalidrawToMermaid } from './excalidrawToMermaid';

const AUTO_NOTE = autoNote('board.json');

/**
 * Turn a sequence or mermaid chart into an Excalidraw board, in place: board.json is
 * written from the mermaid text, then CHART.md flips to `format: excalidraw` with the
 * board's own auto block — one revision-checked patch, so the chart is never half-converted
 * in its frontmatter. The old source (chart.json) is left on disk.
 */
export async function convertChartToExcalidraw(fsRef: FSRef, chart: Chart | undefined, mermaid: string): Promise<void> {
  // parseMermaidToExcalidraw returns skeletons: convertToExcalidrawElements materializes
  // bindings and text children, else boxes render "Untitled" and arrows lose their ends.
  const mermaidMod = (await import('@excalidraw/mermaid-to-excalidraw')) as unknown as {
    parseMermaidToExcalidraw: (text: string) => Promise<{ elements: unknown[]; files?: Record<string, unknown> }>;
  };
  const result = await mermaidMod.parseMermaidToExcalidraw(mermaid);
  const excal = (await import('@excalidraw/excalidraw')) as unknown as {
    convertToExcalidrawElements: (skeleton: unknown[]) => unknown[];
  };
  const elements = excal.convertToExcalidrawElements(result.elements);
  const data = { elements, appState: {}, files: result.files ?? {} };
  await fsRef.child('board.json').write(JSON.stringify({ kind: 'excalidraw', version: 1, data }, null, 2));
  await writeChartMermaid(fsRef.child('CHART.md'), chart, excalidrawToMermaid(data), AUTO_NOTE, {
    format: 'excalidraw',
  });
}

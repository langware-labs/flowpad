import type { Chart, FSRef } from '@sdk';

/**
 * CHART.md's auto-managed mermaid block — the agent-readable text of a chart in ANY format.
 * Excalidraw and sequence charts regenerate it on every save; a mermaid chart's block IS its source.
 */
export const BEGIN_MARKER = '<!-- BEGIN chart:auto -->';
export const END_MARKER = '<!-- END chart:auto -->';
const BLOCK_RE = /<!-- BEGIN chart:auto -->[\s\S]*?<!-- END chart:auto -->/;
const FENCE_RE = /```mermaid\n([\s\S]*?)```/;

/** The note under a regenerated block, naming the file it mirrors. */
export function autoNote(source: string): string {
  return `_Auto-generated from ${source} — edits inside this block are overwritten on next save._`;
}

/** A file or blob as a `data:` URL. */
export function readFileAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

export function spliceMermaidBlock(currentDoc: string, mermaid: string, note: string): string {
  const body = mermaid.endsWith('\n') ? mermaid : mermaid + '\n';
  const block = '```mermaid\n' + body + '```\n';
  const wrapped = `${BEGIN_MARKER}\n${block}\n${note}\n${END_MARKER}`;
  if (BLOCK_RE.test(currentDoc)) return currentDoc.replace(BLOCK_RE, () => wrapped);
  const trimmed = currentDoc.endsWith('\n') ? currentDoc : currentDoc + '\n';
  return `${trimmed}\n${wrapped}\n`;
}

/** The mermaid source in CHART.md: the auto block's fence, else the first mermaid fence anywhere. */
export function extractMermaidBlock(doc: string): string {
  const block = BLOCK_RE.exec(doc)?.[0];
  return FENCE_RE.exec(block ?? doc)?.[1] ?? '';
}

/**
 * Replace a mermaid chart's source where it lives: the auto block when there is one,
 * else the first mermaid fence in place (a hand-written chart keeps its own layout),
 * else a new block.
 */
export function replaceMermaidSource(currentDoc: string, mermaid: string, note: string): string {
  if (BLOCK_RE.test(currentDoc) || !FENCE_RE.test(currentDoc)) return spliceMermaidBlock(currentDoc, mermaid, note);
  const body = mermaid.endsWith('\n') ? mermaid : mermaid + '\n';
  return currentDoc.replace(FENCE_RE, () => '```mermaid\n' + body + '```');
}

/** Read CHART.md, materializing it when a fresh chart has none yet. */
export async function readChartDocument(docRef: FSRef, chart?: Chart) {
  return docRef.readDocument().catch(async (error: unknown) => {
    if (!chart || (error as { response?: { status?: number } })?.response?.status !== 404) throw error;
    await docRef.ensureDocument(chart.typeId, {
      name: chart.name ?? '',
      description: chart.description ?? '',
      format: chart.format,
    });
    return docRef.readDocument();
  });
}

/** Rewrite CHART.md's mermaid block (and optionally frontmatter fields) in one revision-checked patch. */
export async function writeChartMermaid(
  docRef: FSRef,
  chart: Chart | undefined,
  mermaid: string,
  note: string,
  setFields?: Record<string, string>,
  splice: (doc: string, mermaid: string, note: string) => string = spliceMermaidBlock,
): Promise<void> {
  const document = await readChartDocument(docRef, chart);
  await docRef.updateDocument({
    expected_revision: document.revision,
    body: splice(document.body, mermaid, note),
    ...(setFields ? { set_fields: setFields } : {}),
  });
}

import { MarkdownView } from '@src/components/markdown-view';

interface MemoryDiffPaneProps {
  memory?: { content: string; bytes: number };
}

/**
 * Expert-mode-only: full memory.md. A real diff view (which lines were
 * added per cycle by comparing learning.log.md attempt entries) is a
 * Phase 8+ followup; for now we render the full memory inline so the
 * expert user has it without leaving the pane.
 */
export function MemoryDiffPane({ memory }: MemoryDiffPaneProps) {
  if (!memory?.content?.trim()) return null;
  return (
    <details
      data-testid="expert-section-memory-diff"
      className="rounded-md border bg-muted/30"
    >
      <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Memory ({memory.bytes} B)
      </summary>
      <div className="prose prose-sm max-w-none border-t bg-background px-3 py-2 dark:prose-invert">
        <MarkdownView value={memory.content} compact />
      </div>
    </details>
  );
}

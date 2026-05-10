import { MarkdownView } from '@src/components/markdown-view';
import { Brain } from 'lucide-react';

import { CollapsibleSection } from './CollapsibleSection';

export function MemorySection({ memory }: { memory: string | null }) {
  return (
    <CollapsibleSection
      title="Memory"
      hint={memory ? `${new Blob([memory]).size} B · shared across runs` : 'shared across runs'}
      testId="learning-memory-section"
    >
      {!memory?.trim() ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Brain className="h-3.5 w-3.5" />
          No <code>memory.md</code> yet. Click <strong>Improve</strong> on a run to populate it.
        </div>
      ) : (
        <div className="prose prose-sm max-w-none dark:prose-invert">
          <MarkdownView value={memory} compact />
        </div>
      )}
    </CollapsibleSection>
  );
}

/**
 * Workflow-level memory.md pane — collapsible.
 *
 * Pure render: receives the artifact, draws collapsed-or-expanded.
 * Surfaces section-count alongside byte-size so a quick glance tells you
 * "this memory has 4 chunks" instead of just "2917 B".
 */

import { MarkdownView } from '@src/components/markdown-view';
import { cn } from '@src/lib/utils';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { MemoryArtifact } from '../data/types';

interface MemoryPaneProps {
  memory?: MemoryArtifact;
  defaultOpen?: boolean;
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  return `${(b / 1024).toFixed(1)} KB`;
}

export function MemoryPane({ memory, defaultOpen = false }: MemoryPaneProps) {
  const [open, setOpen] = useState(defaultOpen);
  const sectionCount = useMemo(() => {
    if (!memory?.content) return 0;
    return (memory.content.match(/^## /gm) || []).length;
  }, [memory?.content]);
  if (!memory?.content?.trim()) return null;
  return (
    <section data-testid="memory-pane" className="border-b bg-background">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40',
        )}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Brain className="h-3.5 w-3.5" />
        <span className="font-medium uppercase tracking-wide">Memory</span>
        {sectionCount > 0 && (
          <span className="rounded-sm bg-muted px-1 py-px text-[10px] tabular-nums">
            {sectionCount} {sectionCount === 1 ? 'section' : 'sections'}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground/70 tabular-nums">
          {fmtBytes(memory.bytes)}
        </span>
      </button>
      {open && (
        <div className="bg-muted/30 px-5 py-4">
          <div className="prose prose-sm mx-auto max-w-3xl dark:prose-invert prose-headings:mt-4 prose-headings:mb-2 prose-headings:text-[11px] prose-headings:font-semibold prose-headings:uppercase prose-headings:tracking-wide prose-headings:text-muted-foreground prose-h2:mt-0 prose-p:my-1.5 prose-li:my-0.5 prose-code:text-[12px] prose-code:before:content-[''] prose-code:after:content-['']">
            <MarkdownView value={memory.content} compact />
          </div>
        </div>
      )}
    </section>
  );
}

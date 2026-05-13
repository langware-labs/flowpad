import { Brain } from "lucide-react";

import { Markdown } from "./Markdown";
import type { MemoryArtifact } from "./types";

interface MemoryPanelProps {
  memory?: MemoryArtifact;
}

export function MemoryPanel({ memory }: MemoryPanelProps) {
  if (!memory || !memory.content.trim()) {
    return (
      <div
        className="mx-auto max-w-3xl px-6 py-12 text-center"
        data-testid="workflow-memory-panel"
      >
        <Brain className="mx-auto h-8 w-8 text-muted-foreground/40" />
        <div className="mt-3 text-sm font-medium text-foreground">
          No memory yet
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          The learning agent hasn't recorded any learnings for this workflow.
          Run the workflow + analyzer + learner to populate memory.md.
        </div>
      </div>
    );
  }

  return (
    <div
      className="mx-auto max-w-3xl px-6 py-6"
      data-testid="workflow-memory-panel"
    >
      <div className="mb-4 flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        <Brain className="h-3.5 w-3.5" />
        Workflow memory · {memory.bytes} B
      </div>
      <Markdown text={memory.content} className="prose prose-sm max-w-none dark:prose-invert" />
    </div>
  );
}

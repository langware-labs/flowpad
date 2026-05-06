import { useState } from 'react';
import { ChevronDown, ChevronRight, Brain } from 'lucide-react';
import type { AssistantMessageEntry } from '@sdk/utils/agent-transcript';

interface Props {
  entry: AssistantMessageEntry;
}

export function AssistantMessageView({ entry }: Props) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const hasText = !!(entry.text && entry.text.trim());
  const hasThinking = !!(entry.thinking && entry.thinking.trim());

  return (
    <div
      className="flex flex-col gap-1"
      data-entry-kind="assistant_message"
      data-entry-id={entry.id}
      data-entry-ts={entry.timestamp}
    >
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>assistant</span>
        {entry.phase && <span className="rounded bg-muted px-1 py-px">{entry.phase}</span>}
        {entry.model && <span>{entry.model}</span>}
      </div>
      {hasThinking && (
        <button
          type="button"
          onClick={() => setThinkingOpen((v) => !v)}
          className="flex items-center gap-1 self-start rounded border border-dashed border-muted-foreground/30 px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/50"
        >
          {thinkingOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <Brain className="h-3 w-3" />
          thinking ({entry.thinking!.length} chars)
        </button>
      )}
      {hasThinking && thinkingOpen && (
        <pre className="whitespace-pre-wrap break-words rounded border border-muted-foreground/20 bg-muted/30 p-2 text-[11px] text-muted-foreground">
          {entry.thinking}
        </pre>
      )}
      {hasText && (
        <div className="max-w-[90%] whitespace-pre-wrap break-words rounded-lg bg-muted/40 px-3 py-2 text-sm">
          {entry.text}
        </div>
      )}
      {!hasText && !hasThinking && (
        <div className="text-xs italic text-muted-foreground">(empty assistant message)</div>
      )}
    </div>
  );
}

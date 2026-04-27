import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { Attachment } from '@sdk/entities/flow-message';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@src/components/ui/dialog';

interface PromptApprovalRowProps {
  attachment: Attachment;
  onApprove: () => void;
}

const TRIM_LIMIT = 90;

function truncate(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= limit) return oneLine;
  return oneLine.slice(0, limit - 1).trimEnd() + '…';
}

export function PromptApprovalRow({ attachment, onApprove }: PromptApprovalRowProps) {
  const [promptText, setPromptText] = useState<string>(() => {
    if (attachment.data && !attachment.data.startsWith('prompt/')) return attachment.data;
    return '';
  });

  useEffect(() => {
    if (promptText) return;
    if (!attachment.data?.startsWith('prompt/') || !attachment.local_path) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(attachment.local_path!);
        if (!res.ok) return;
        const text = await res.text();
        if (!cancelled) setPromptText(text);
      } catch {
        // leave empty — fallback rendering below
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attachment.data, attachment.local_path, promptText]);

  const fallback = attachment.data?.startsWith('prompt/')
    ? `(prompt file: ${attachment.data})`
    : '';
  const displayText = promptText || fallback;
  const trimmed = truncate(displayText, TRIM_LIMIT);

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[12px] text-muted-foreground">
      <span className="shrink-0">Prompt to run:</span>
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            title="Click to view full prompt"
            className="min-w-0 max-w-full truncate rounded px-1.5 py-0.5 text-left italic text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
          >
            “{trimmed}”
          </button>
        </DialogTrigger>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Prompt to run</DialogTitle>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 font-mono text-xs text-foreground">
            {displayText || '(prompt content unavailable)'}
          </pre>
        </DialogContent>
      </Dialog>
      <button
        type="button"
        onClick={onApprove}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/20 dark:text-emerald-300"
      >
        <Sparkles className="h-3 w-3" />
        Approve &amp; Execute
      </button>
    </div>
  );
}

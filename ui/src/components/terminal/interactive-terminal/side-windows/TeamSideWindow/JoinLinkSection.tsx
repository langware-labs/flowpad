import { Button } from '@src/components/ui/button';
import { useToast } from '@src/hooks/use-toast';
import { Check, Copy, Link as LinkIcon } from 'lucide-react';
import { useCallback, useState } from 'react';

interface JoinLinkSectionProps {
  sessionCode: string;
  joinUrl: string;
}

export function JoinLinkSection({ sessionCode, joinUrl }: JoinLinkSectionProps) {
  const { toast } = useToast();
  const [copiedTarget, setCopiedTarget] = useState<'link' | 'code' | null>(null);

  const handleCopy = useCallback(
    (target: 'link' | 'code', value: string, description: string) => {
      void navigator.clipboard.writeText(value);
      setCopiedTarget(target);
      setTimeout(() => setCopiedTarget((t) => (t === target ? null : t)), 2000);
      toast({ title: 'Copied', description });
    },
    [toast],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col items-center gap-1 rounded-xl bg-muted/50 py-4">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">Session code</p>
        <button
          type="button"
          className="font-mono text-2xl font-bold tracking-widest text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          onClick={() => handleCopy('code', sessionCode, 'Session code copied to clipboard.')}
          title="Copy session code"
        >
          {sessionCode || '—'}
        </button>
        {copiedTarget === 'code' && <span className="text-[11px] text-green-600">Code copied</span>}
      </div>

      <div className="flex gap-2">
        <div className="flex flex-1 items-center gap-2 truncate rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <LinkIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{joinUrl}</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5"
          onClick={() => handleCopy('link', joinUrl, 'Share it with anyone you want to collaborate with.')}
        >
          {copiedTarget === 'link' ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
          {copiedTarget === 'link' ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

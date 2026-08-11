import { useCallback, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Check, Copy } from 'lucide-react';
import { copyToClipboard } from '@sdk';
import { cn } from '@src/lib/utils';

/** Compact path row shared by address-bar detail cards. */
export function CopyPathButton({ path, testId, className }: { path: string; testId: string; className?: string }) {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void copyToClipboard(path);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [path]);

  return (
    <button
      type="button"
      onClick={copy}
      title={t`Copy path`}
      aria-label={t`Copy path`}
      data-testid={testId}
      className={cn(
        'flex items-center gap-1.5 rounded-sm px-1 py-1 text-left font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground',
        className,
      )}
    >
      <span className="min-w-0 flex-1 truncate">{path}</span>
      {copied ? <Check className="h-3 w-3 shrink-0 text-green-500" /> : <Copy className="h-3 w-3 shrink-0" />}
    </button>
  );
}

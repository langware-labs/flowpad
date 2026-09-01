import { useLingui } from '@lingui/react/macro';
import { CopyButton } from '@src/components/ui/copy-button';
import { cn } from '@src/lib/utils';

/** Compact path row shared by address-bar detail cards. */
export function CopyPathButton({ path, testId, className }: { path: string; testId: string; className?: string }) {
  const { t } = useLingui();

  return (
    <CopyButton
      value={path}
      testId={testId}
      title={t`Copy path`}
      copiedIconClassName="text-green-500"
      className={cn(
        'gap-1.5 rounded-sm px-1 py-1 text-left font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground',
        className,
      )}
    >
      <span className="min-w-0 flex-1 truncate">{path}</span>
    </CopyButton>
  );
}

import { cn } from '@src/lib/utils';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { QuickCreateModal } from './QuickCreateModal';
import { useQuickCreatePick } from './QuickCreatePanel';

/**
 * QuickCreateTile — the "+ New" tile that opens the quick-create modal. Owns
 * the modal and the quick-create dialog set, so a host drops it in as-is: the
 * home landing shows it on its own, the desktop surface leads its grid with it.
 */
export function QuickCreateTile({ size = 'default', className }: { size?: 'default' | 'large'; className?: string }) {
  const { t } = useLingui();
  const [modalOpen, setModalOpen] = useState(false);
  const { panelProps, dialogs } = useQuickCreatePick();

  return (
    <>
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        aria-label={t`Quick create`}
        title={t`Create new…`}
        className={cn(
          'flex flex-col items-center justify-center gap-1 rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-primary hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          size === 'large' ? 'h-20 w-20' : 'h-16 w-16',
          className,
        )}
      >
        <Plus className="h-6 w-6" />
        <span className="text-[10px] font-medium leading-none"><Trans>New</Trans></span>
      </button>

      <QuickCreateModal open={modalOpen} onOpenChange={setModalOpen} panelProps={panelProps} />
      {dialogs}
    </>
  );
}

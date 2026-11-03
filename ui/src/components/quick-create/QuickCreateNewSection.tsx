import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { useQuickCreatePick } from './QuickCreatePanel';
import { QuickCreateModal } from './QuickCreateModal';

/** The homes' "New" — one button opening the full create menu; its project chip picks the target. */
export function QuickCreateNewSection({ testId }: { testId: string }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const { panelProps, dialogs } = useQuickCreatePick();
  return (
    <section className="self-start text-start">
      <h3 className="mb-2 text-sm font-semibold">
        <Trans>New</Trans>
      </h3>
      <Button variant="outline" size="icon" aria-label={t`Create new`} data-testid={testId} onClick={() => setOpen(true)}>
        <Plus className="size-5" />
      </Button>
      <QuickCreateModal
        open={open}
        onOpenChange={setOpen}
        panelProps={panelProps}
        sections={['build', 'write', 'connect', 'project']}
        showAddExisting
        allUserTypes
      />
      {dialogs}
    </section>
  );
}

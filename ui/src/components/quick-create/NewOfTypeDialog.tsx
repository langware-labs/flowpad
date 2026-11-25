import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { InputDialog } from '@src/components/ui/input-dialog';
import { useCloudAuthed } from '@src/hooks/use-cloud-authed';
import { customDialogFor } from './registry';

/**
 * The assets "+" for one type: the type's own create dialog when its descriptor brings one (a chart
 * asks for its format), else the generic name-only form. Custom Setup in the type's dialog switches to
 * the name-only form for the rest of this opening.
 */
export function NewOfTypeDialog({
  type,
  open,
  onOpenChange,
  projectId,
  onConfirmName,
}: {
  type: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
  onConfirmName: (name: string) => void;
}) {
  const { t } = useLingui();
  const [customSetup, setCustomSetup] = useState(false);
  const typeDialog = customDialogFor(type, useCloudAuthed());
  const handleOpenChange = (next: boolean) => {
    if (!next) setCustomSetup(false);
    onOpenChange(next);
  };
  const Dialog = customSetup ? undefined : typeDialog;
  if (Dialog)
    return (
      <Dialog
        open={open}
        onOpenChange={handleOpenChange}
        projectId={projectId}
        onCustomSetup={() => setCustomSetup(true)}
      />
    );
  return (
    <InputDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t`New ${type ?? ''}`}
      description={t`Enter a name for the new ${type ?? 'item'}.`}
      placeholder={t`Name`}
      confirmLabel={t`Create`}
      onConfirm={onConfirmName}
    />
  );
}

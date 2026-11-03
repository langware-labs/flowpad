import { useLingui } from '@lingui/react/macro';
import { InputDialog } from '@src/components/ui/input-dialog';
import { getDescriptor } from './registry';

/**
 * The assets "+" for one type: the type's own create dialog when its descriptor brings one (a chart
 * asks for its format), else the generic name-only form.
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
  const Dialog = type ? getDescriptor(type)?.Dialog : undefined;
  if (Dialog) return <Dialog open={open} onOpenChange={onOpenChange} projectId={projectId} />;
  return (
    <InputDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t`New ${type ?? ''}`}
      description={t`Enter a name for the new ${type ?? 'item'}.`}
      placeholder={t`Name`}
      confirmLabel={t`Create`}
      onConfirm={onConfirmName}
    />
  );
}

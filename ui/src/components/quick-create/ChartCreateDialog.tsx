import React, { useState } from 'react';
import { Chart, Project, TypeId, type ChartFormat } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Trans, useLingui } from '@lingui/react/macro';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';

/**
 * New chart. The one question the generic name form cannot ask is HOW it is drawn —
 * the format fixes which file in the folder is the source, so it is chosen up front.
 */
export const ChartCreateDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId?: string | null;
}> = ({ open, onOpenChange, projectId = null }) => {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [name, setName] = useState('');
  const [format, setFormat] = useState<ChartFormat>('sequence');
  const [busy, setBusy] = useState(false);

  // Built in render: `t` must run under the active locale.
  const formats: { value: ChartFormat; label: string; hint: string }[] = [
    { value: 'sequence', label: t`Sequence`, hint: t`who calls whom, step by step — with sub-flows and feedback` },
    { value: 'excalidraw', label: t`Whiteboard (Excalidraw)`, hint: t`a freehand board to draw on` },
    { value: 'mermaid', label: t`Mermaid`, hint: t`any diagram written as mermaid text` },
  ];

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const project = projectId ? { typeId: new TypeId(Project.type, projectId) } : null;
      const saved = await Chart.createInProject(project, trimmed, format);
      onOpenChange(false);
      setName('');
      notify.success({ title: t`Chart created` });
      if (saved.asset_ref) navigation.openDock(DockPointer.forAssetEditor(Chart.type, saved.asset_ref));
    } catch (error) {
      notify.error({
        title: t`Could not create the chart`,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Trans>New chart</Trans>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Input
            autoFocus
            value={name}
            placeholder={t`Name`}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !busy && void create()}
            data-testid="chart-create-name"
          />

          <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={t`Format`}>
            {formats.map((option) => (
              <label key={option.value} className="flex cursor-pointer items-start gap-2 rounded-md p-2 hover:bg-muted">
                <input
                  type="radio"
                  name="chart-format"
                  className="mt-1"
                  checked={format === option.value}
                  onChange={() => setFormat(option.value)}
                  data-testid={`chart-format-${option.value}`}
                />
                <span className="flex flex-col">
                  <span className="text-sm">{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button disabled={!name.trim() || busy} onClick={() => void create()} data-testid="chart-create-submit">
            <Trans>Create</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

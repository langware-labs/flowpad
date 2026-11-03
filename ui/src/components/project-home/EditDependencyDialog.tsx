import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { DependencyState } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { DependencyKindChips } from '@src/components/assets/dependency-sources';
import type { DependencyKind } from '@src/hooks/use-project-dependencies';
import { notify } from '@src/notifications';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';

interface DependencyPatch {
  source?: string;
  optional?: boolean;
  label?: string;
  description?: string;
}

interface EditDependencyDialogProps {
  dependency: DependencyState;
  onClose: () => void;
  /** Writes only the changed fields to flow.json. */
  onSave: (patch: DependencyPatch) => Promise<unknown>;
}

const Field: React.FC<{
  id: string;
  label: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}> = ({ id, label, value, onChange, placeholder, className }) => (
  <div className="flex flex-col gap-1.5">
    <Label htmlFor={id}>{label}</Label>
    <Input id={id} className={className} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  </div>
);

/** Edit one `flow.json` package: its source, required/optional, and its label/description. */
export const EditDependencyDialog: React.FC<EditDependencyDialogProps> = ({ dependency, onClose, onSave }) => {
  const { t } = useLingui();
  const initial = {
    source: dependency.source,
    kind: (dependency.required ? 'required' : 'optional') as DependencyKind,
    label: dependency.label ?? '',
    description: dependency.description ?? '',
  };
  const [edit, setEdit] = useState(initial);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<typeof initial>) => setEdit((e) => ({ ...e, ...patch }));

  const save = async () => {
    const patch: DependencyPatch = {};
    if (edit.source.trim() !== initial.source) patch.source = edit.source.trim();
    if (edit.kind !== initial.kind) patch.optional = edit.kind === 'optional';
    if (edit.label.trim() !== initial.label) patch.label = edit.label.trim();
    if (edit.description.trim() !== initial.description) patch.description = edit.description.trim();
    if (Object.keys(patch).length === 0) return onClose();
    setSaving(true);
    try {
      await onSave(patch);
      onClose();
    } catch (err) {
      notify.error({ title: t`Could not save the package`, message: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="dependency-edit-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Edit package {dependency.name}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Changes are written to the project's flow.json.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <DependencyKindChips kind={edit.kind} onChange={(kind) => set({ kind })} allowLocal={false} />
          <Field
            id="dependency-edit-source"
            label={<Trans>Source</Trans>}
            className="font-mono text-xs"
            value={edit.source}
            onChange={(source) => set({ source })}
          />
          <Field
            id="dependency-edit-label"
            label={<Trans>Label</Trans>}
            placeholder={dependency.name}
            value={edit.label}
            onChange={(label) => set({ label })}
          />
          <Field
            id="dependency-edit-description"
            label={<Trans>Description</Trans>}
            value={edit.description}
            onChange={(description) => set({ description })}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => void save()} disabled={saving || !edit.source.trim()} data-testid="dependency-edit-save">
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}
            <Trans>Save</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

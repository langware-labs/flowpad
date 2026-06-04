import React, { useEffect, useState } from 'react';
import { Prompt } from '@sdk';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Textarea } from '@src/components/ui/textarea';
import { ColorPicker } from '@src/components/ui/color-picker';
import { IconPicker } from '@src/components/ui/icon-picker';

/**
 * PromptEditDialog — add/edit a library prompt (docs/prompt-library.md).
 *
 * Zero logic: form state in, one SDK call out (`Prompt.create` or
 * `prompt.save()`). Icon + color come from the GENERIC pickers
 * (`components/ui/`) — the curated contrast-tested palette and the
 * lucide+emoji tabs; this dialog is merely their first consumer.
 */
export interface PromptEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit target; omit for create. */
  prompt?: Prompt | null;
  /** Folder for a newly created prompt (null = library root). */
  groupId?: string | null;
  projectId?: string | null;
  onSaved?: () => void;
}

export const PromptEditDialog: React.FC<PromptEditDialogProps> = ({
  open,
  onOpenChange,
  prompt,
  groupId = null,
  projectId = null,
  onSaved,
}) => {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [icon, setIcon] = useState<string | null>(null);
  const [color, setColor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(prompt?.name ?? '');
      setText(prompt?.text ?? '');
      setIcon(prompt?.icon ?? null);
      setColor(prompt?.color ?? null);
      setSaving(false);
    }
  }, [open, prompt]);

  const canSave = name.trim().length > 0 && text.trim().length > 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      if (prompt) {
        prompt.name = name.trim();
        prompt.text = text.trim();
        prompt.icon = icon;
        prompt.color = color;
        await prompt.save();
      } else {
        await Prompt.create({
          name: name.trim(),
          text: text.trim(),
          icon,
          color,
          groupId,
          projectId,
        });
      }
      onSaved?.();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{prompt ? 'Edit prompt' : 'New prompt'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Prompt name"
            aria-label="Prompt name"
            autoFocus
          />
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="The prompt text…"
            aria-label="Prompt text"
            className="min-h-28"
          />
          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">Icon</span>
            <IconPicker value={icon} onChange={setIcon} />
          </div>
          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">Color</span>
            <ColorPicker value={color} onChange={setColor} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {prompt ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

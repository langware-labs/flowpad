import { useState, useEffect } from 'react';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Textarea } from '@src/components/ui/textarea';

interface InputDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: (value: string) => void;
  onCancel?: () => void;
  /** A paragraph rather than a line: a Textarea, where Enter is a newline and Cmd/Ctrl+Enter confirms. */
  multiline?: boolean;
  /** Marks the dialog `<testId>`, its field `<testId>-input` and its confirm button `<testId>-send`. */
  testId?: string;
}

export function InputDialog({
  open,
  onOpenChange,
  title,
  description,
  placeholder = '',
  defaultValue = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  multiline = false,
  testId,
}: InputDialogProps) {
  const [value, setValue] = useState(defaultValue);

  // Reset value when dialog opens
  useEffect(() => {
    if (open) {
      setValue(defaultValue);
    }
  }, [open, defaultValue]);

  const handleConfirm = () => {
    if (value.trim()) {
      onConfirm(value.trim());
      onOpenChange(false);
    }
  };

  const handleCancel = () => {
    onCancel?.();
    onOpenChange(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey) && value.trim()) {
      handleConfirm();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid={testId}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="py-4">
          {multiline ? (
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              data-testid={testId && `${testId}-input`}
              autoFocus
            />
          ) : (
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              data-testid={testId && `${testId}-input`}
              autoFocus
            />
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            {cancelLabel}
          </Button>
          <Button onClick={handleConfirm} disabled={!value.trim()} data-testid={testId && `${testId}-send`}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

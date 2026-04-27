import { useEffect, useState } from 'react';
import { sendReply } from '@sdk/entities/notifications';
import type { ITask } from '@sdk/entities/task';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Button } from '@src/components/ui/button';
import { FileAttachmentPicker } from './FileAttachmentPicker';

interface PromptComposerDialogProps {
  open: boolean;
  onClose: () => void;
  task: ITask;
  onSent?: () => void;
}

export function PromptComposerDialog({ open, onClose, task, onSent }: PromptComposerDialogProps) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setText('');
      setFiles([]);
      setError(null);
    }
  }, [open]);

  const canSend = (text.trim().length > 0 || files.length > 0) && !busy;

  const handleSubmit = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      await sendReply(task, '', undefined, {
        promptText: text.trim() || undefined,
        promptFiles: files.length > 0 ? files : undefined,
      });
      onSent?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send prompt');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Propose a prompt</DialogTitle>
          <DialogDescription>
            Type a prompt or attach a file. The other user will see an "Approve &amp; Execute" button on this message; once approved, the prompt runs in their forked Claude Code session.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Describe what you'd like Claude to do…"
            rows={6}
            disabled={busy}
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none disabled:opacity-50"
          />
          <FileAttachmentPicker files={files} onChange={setFiles} disabled={busy} />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void handleSubmit()} disabled={!canSend}>
            {busy ? 'Sending…' : 'Send prompt'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

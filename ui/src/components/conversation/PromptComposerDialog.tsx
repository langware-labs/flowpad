import { useEffect, useState } from 'react';
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

export interface QueuedPrompt {
  text: string;
  files: File[];
}

interface PromptComposerDialogProps {
  open: boolean;
  onClose: () => void;
  /** Initial values when reopening to edit a queued prompt. */
  initial?: QueuedPrompt | null;
  /** Called when the user confirms — the prompt is *queued*, not sent. */
  onQueue: (prompt: QueuedPrompt) => void;
  /** Optional one-click "queue + send the reply now" handler. When provided, a
   *  Send button appears next to "Attach to reply" so the user doesn't have to
   *  attach, then click Send in the composer. */
  onQueueAndSend?: (prompt: QueuedPrompt) => void;
}

export function PromptComposerDialog({ open, onClose, initial, onQueue, onQueueAndSend }: PromptComposerDialogProps) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);

  useEffect(() => {
    if (open) {
      setText(initial?.text ?? '');
      setFiles(initial?.files ?? []);
    }
  }, [open, initial]);

  const canQueue = text.trim().length > 0 || files.length > 0;

  const handleQueue = () => {
    if (!canQueue) return;
    onQueue({ text: text.trim(), files });
    onClose();
  };

  const handleQueueAndSend = () => {
    if (!canQueue || !onQueueAndSend) return;
    onQueueAndSend({ text: text.trim(), files });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a prompt to your reply</DialogTitle>
          <DialogDescription>
            The prompt will be attached to your next message. The other user will see an "Approve &amp; Execute" chip; once approved, the prompt runs in their forked Claude Code session.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Describe what you'd like Claude to do…"
            rows={6}
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
          />
          <FileAttachmentPicker files={files} onChange={setFiles} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleQueue} disabled={!canQueue} variant="secondary">
            Attach to reply
          </Button>
          {onQueueAndSend && (
            <Button onClick={handleQueueAndSend} disabled={!canQueue}>
              Send
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

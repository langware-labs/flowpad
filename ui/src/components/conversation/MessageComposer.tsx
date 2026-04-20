import { useState } from 'react';
import { Send } from 'lucide-react';
import { sendReply } from '@sdk/entities/notifications';
import type { ITask } from '@sdk/entities/task';
import { FileAttachmentPicker } from './FileAttachmentPicker';

interface MessageComposerProps {
  task: ITask;
  disabled?: boolean;
  onSent?: () => void;
}

export function MessageComposer({ task, disabled, onSent }: MessageComposerProps) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendReply(task, trimmed);
      setText('');
      setFiles([]);
      onSent?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send reply.');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      void handleSend();
    }
  };

  return (
    <div className="space-y-1.5">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Reply to sender..."
        rows={3}
        disabled={disabled || sending}
        className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <FileAttachmentPicker files={files} onChange={setFiles} disabled={disabled || sending} />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <button
        onClick={() => void handleSend()}
        disabled={!text.trim() || sending || disabled}
        className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Send className="h-3 w-3" />
        {sending ? 'Sending...' : 'Send Reply'}
      </button>
    </div>
  );
}

import React, { useState } from 'react';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Switch } from '@src/components/ui/switch';
import type { QueueEntry, QueueState } from '@src/hooks/useAgenticQueue';

interface QueueWindowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queue: QueueState;
  onAdd: (entry: QueueEntry) => void;
  onRemove: (index: number) => void;
  onMove: (index: number, direction: 'up' | 'down') => void;
  onSetEnabled: (enabled: boolean) => void;
}

export const QueueWindow: React.FC<QueueWindowProps> = ({
  open,
  onOpenChange,
  queue,
  onAdd,
  onRemove,
  onMove,
  onSetEnabled,
}) => {
  const [promptText, setPromptText] = useState('');
  const [delay, setDelay] = useState(0);

  const handleAdd = () => {
    if (!promptText.trim()) return;
    onAdd({ queue_entry_type: 'prompt', queue_entry_data: { prompt: promptText.trim() }, delay });
    setPromptText('');
    setDelay(0);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle>Prompt Queue</DialogTitle>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {queue.enabled ? 'enabled' : 'disabled'}
              </span>
              <Switch checked={queue.enabled} onCheckedChange={onSetEnabled} />
            </div>
          </div>
        </DialogHeader>
        <div className="space-y-1 max-h-56 overflow-y-auto">
          {(queue.entries ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              Queue is empty. Add a prompt to get started.
            </p>
          ) : (
            (queue.entries ?? []).map((entry, i) => (
              <div key={i} className="flex items-center gap-2 rounded border px-2 py-1.5 text-xs">
                <span className="shrink-0 rounded bg-blue-500/20 px-1 text-[9px] font-mono">
                  Prompt
                </span>
                <span className="flex-1 truncate">{entry.queue_entry_data.prompt}</span>
                <span className="shrink-0 text-muted-foreground">delay:{entry.delay ?? 0}s</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0"
                  onClick={() => onMove(i, 'up')}
                  disabled={i === 0}
                >
                  ↑
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0"
                  onClick={() => onMove(i, 'down')}
                  disabled={i === (queue.entries ?? []).length - 1}
                >
                  ↓
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0 text-destructive"
                  onClick={() => onRemove(i)}
                >
                  ×
                </Button>
              </div>
            ))
          )}
        </div>
        <div className="border-t pt-3">
          <p className="text-xs font-medium mb-2">Add new entry</p>
          <div className="space-y-2">
            <textarea
              className="w-full rounded border bg-background p-2 text-xs resize-none h-16"
              placeholder="Prompt text..."
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Delay:</span>
              <input
                type="number"
                min={0}
                className="w-16 rounded border bg-background px-1.5 py-0.5 text-xs"
                value={delay}
                onChange={(e) => setDelay(Number(e.target.value))}
              />
              <span className="text-xs text-muted-foreground">seconds</span>
              <Button size="sm" className="ml-auto h-7 text-xs" onClick={handleAdd}>
                Add to Queue
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

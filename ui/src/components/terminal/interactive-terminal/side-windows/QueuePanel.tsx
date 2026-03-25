import React, { useState } from 'react';
import { Button } from '@src/components/ui/button';
import { Switch } from '@src/components/ui/switch';
import type { QueueEntry, QueueState } from '@src/hooks/useAgenticQueue';

interface QueuePanelProps {
  queue: QueueState;
  onAdd: (entry: QueueEntry) => void;
  onRemove: (index: number) => void;
  onMove: (index: number, direction: 'up' | 'down') => void;
  onSetEnabled: (enabled: boolean) => void;
}

export const QueuePanel: React.FC<QueuePanelProps> = ({
  queue,
  onAdd,
  onRemove,
  onMove,
  onSetEnabled,
}) => {
  const [promptText, setPromptText] = useState('');
  const [delay, setDelay] = useState(0);
  const [delayUnit, setDelayUnit] = useState<'sec' | 'min'>('sec');

  const entries = queue.entries ?? [];

  const handleAdd = () => {
    if (!promptText.trim()) return;
    const delaySec = delayUnit === 'min' ? delay * 60 : delay;
    onAdd({ queue_entry_type: 'prompt', queue_entry_data: { prompt: promptText.trim() }, delay: delaySec });
    setPromptText('');
    setDelay(0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium">Prompt Queue</span>
        <Switch
          checked={queue.enabled}
          onCheckedChange={onSetEnabled}
        />
        <span className="text-xs text-muted-foreground">{queue.enabled ? 'on' : 'off'}</span>
      </div>

      {/* Queue entries */}
      <div className="flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <p className="mt-6 px-3 text-center text-xs text-muted-foreground">
            No prompts queued. Add one below.
          </p>
        ) : (
          <div className="divide-y">
            {entries.map((entry, i) => (
              <div key={i} className="flex items-start gap-2 px-3 py-2 text-xs hover:bg-muted/30">
                <span className="mt-0.5 w-4 shrink-0 text-right text-muted-foreground">{i + 1}.</span>
                <div className="min-w-0 flex-1">
                  <p className="break-words leading-relaxed">{entry.queue_entry_data.prompt}</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {(entry.delay ?? 0) === 0
                      ? 'inject immediately'
                      : `delay: ${(entry.delay ?? 0) >= 60 ? `${Math.round((entry.delay ?? 0) / 60)}m` : `${entry.delay}s`}`}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col gap-0.5">
                  <Button
                    variant="ghost" size="sm" className="h-5 w-5 p-0"
                    onClick={() => onMove(i, 'up')} disabled={i === 0}
                  >↑</Button>
                  <Button
                    variant="ghost" size="sm" className="h-5 w-5 p-0"
                    onClick={() => onMove(i, 'down')} disabled={i === entries.length - 1}
                  >↓</Button>
                  <button
                    className="flex h-5 w-5 items-center justify-center text-muted-foreground hover:text-destructive"
                    onClick={() => onRemove(i)}
                  >×</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add new entry */}
      <div className="border-t p-3 space-y-2">
        <textarea
          className="w-full rounded-md border bg-background px-2.5 py-2 text-xs resize-none h-20 focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder="Next prompt to auto-inject when agent goes idle. Press Enter to add."
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground shrink-0">Delay</span>
          <input
            type="range"
            min={0}
            max={delayUnit === 'sec' ? 60 : 30}
            value={delay}
            onChange={(e) => setDelay(Number(e.target.value))}
            className="flex-1 accent-amber-500"
          />
          <span className="text-xs w-8 text-right tabular-nums">{delay}{delayUnit === 'sec' ? 's' : 'm'}</span>
          <div className="flex rounded-md border text-[10px] overflow-hidden shrink-0">
            <button
              className={`px-1.5 py-0.5 ${delayUnit === 'sec' ? 'bg-muted font-semibold' : 'text-muted-foreground'}`}
              onClick={() => { setDelayUnit('sec'); setDelay(0); }}
            >Sec</button>
            <button
              className={`px-1.5 py-0.5 ${delayUnit === 'min' ? 'bg-muted font-semibold' : 'text-muted-foreground'}`}
              onClick={() => { setDelayUnit('min'); setDelay(0); }}
            >Min</button>
          </div>
        </div>
        <Button size="sm" className="w-full h-7 text-xs" onClick={handleAdd} disabled={!promptText.trim()}>
          Add to Queue
        </Button>
      </div>
    </div>
  );
};

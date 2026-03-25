import { ListOrdered } from 'lucide-react';
import React, { useRef, useState } from 'react';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import type { QueueEntry, QueueState } from '@src/hooks/useAgenticQueue';

interface QueueButtonProps {
  queue: QueueState;
  onAdd: (entry: QueueEntry) => void;
  onRemove: (index: number) => void;
  onOpenPanel: () => void;
}

export const QueueButton: React.FC<QueueButtonProps> = ({ queue, onAdd, onRemove, onOpenPanel }) => {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [promptText, setPromptText] = useState('');
  const [delay, setDelay] = useState(0);
  const [delayUnit, setDelayUnit] = useState<'sec' | 'min'>('sec');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const entries = queue.entries ?? [];
  const count = entries.length;

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
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2"
        >
          <ListOrdered className="h-3.5 w-3.5" />
          {count > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-semibold text-black">
              {count > 99 ? '99+' : count}
            </span>
          )}
        </Button>
      </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          Prompt queue — prompts added here are auto-injected when the agent goes idle
        </TooltipContent>
      </Tooltip>
      <PopoverContent className="w-72 p-0" align="start">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">Queue</span>
          <button
            className="text-xs text-primary hover:underline"
            onClick={() => { onOpenPanel(); setPopoverOpen(false); }}
          >
            Manage →
          </button>
        </div>
        <div className="p-3 space-y-2">
          <textarea
            ref={textareaRef}
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
              step={delayUnit === 'sec' ? 1 : 1}
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
        {entries.length > 0 && (
          <div className="border-t">
            <div className="max-h-36 overflow-y-auto divide-y">
              {entries.map((entry, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/50">
                  <span className="text-muted-foreground shrink-0 w-4 text-right">{i + 1}.</span>
                  <span className="flex-1 truncate">{entry.queue_entry_data.prompt}</span>
                  {(entry.delay ?? 0) > 0 && (
                    <span className="shrink-0 text-muted-foreground/60 text-[10px]">{entry.delay}s</span>
                  )}
                  <button
                    onClick={() => onRemove(i)}
                    className="shrink-0 text-muted-foreground hover:text-destructive leading-none"
                  >×</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};

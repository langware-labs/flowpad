import React, { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { Switch } from '@src/components/ui/switch';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';
import type { AgenticProcess } from '@sdk/process/agentic-process';

interface QueuePanelProps {
  /**
   * The process whose queue this panel shows. The panel is purely
   * declarative: it reads ``queue`` (reflected backend state, refreshed live
   * via ``data_op``) and mutates exclusively through the entity's queue action
   * methods. There is no client-side queue state or injection logic — the
   * backend owns the file and the drain.
   */
  process: AgenticProcess;
}

export const QueuePanel: React.FC<QueuePanelProps> = ({ process }) => {
  const { t } = useLingui();
  // The ONLY local state is the draft text in the add box — pure input UI.
  const [promptText, setPromptText] = useState('');

  // Subscribe to the entity so queue mutations re-render this panel. The
  // `process` prop comes from the loader context (a stable object ref) and
  // `data_op` updates mutate it IN PLACE — without a subscription React never
  // re-renders. `useEntity` returns the same cached instance but forces a
  // re-render on every update. (Reactive read only — still zero queue logic.)
  const live = useEntity<AgenticProcess>(process.typeId).data ?? process;

  const queue = live.queue;
  const entries = queue?.entries ?? [];
  const enabled = queue?.enabled ?? true;

  const handleAdd = () => {
    const text = promptText.trim();
    if (!text) return;
    void live.enqueue(text);
    setPromptText('');
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
        <span className="text-sm font-medium">
          <Trans>Prompt Queue</Trans>
        </span>
        <Switch checked={enabled} onCheckedChange={(v) => void live.setQueueEnabled(v)} />
        <span className="text-xs text-muted-foreground">{enabled ? t`on` : t`off`}</span>
        {entries.length > 0 && (
          <button
            className="ms-auto text-[10px] text-muted-foreground hover:text-destructive"
            onClick={() => void live.clearQueue()}
          >
            <Trans>Clear</Trans>
          </button>
        )}
      </div>

      {/* Queue entries */}
      <div className="flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <p className="mt-6 px-3 text-center text-xs text-muted-foreground">
            <Trans>No prompts queued. Add one below.</Trans>
          </p>
        ) : (
          <div className="divide-y">
            {entries.map((entry, i) => (
              <div key={entry.id} className="flex items-start gap-2 px-3 py-2 text-xs hover:bg-muted/30">
                <span className="mt-0.5 w-4 shrink-0 text-end text-muted-foreground">{i + 1}.</span>
                <p className="min-w-0 flex-1 break-words leading-relaxed">{entry.prompt}</p>
                <button
                  className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground hover:text-destructive"
                  onClick={() => void live.dequeue(entry.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add new entry */}
      <div className="space-y-2 border-t p-3">
        <textarea
          className="h-20 w-full resize-none rounded-md border bg-background px-2.5 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder={t`Next prompt — injected when the agent next goes idle. Press Enter to add.`}
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <Button size="sm" className="h-7 w-full text-xs" onClick={handleAdd} disabled={!promptText.trim()}>
          <Trans>Add to Queue</Trans>
        </Button>
      </div>
    </div>
  );
};

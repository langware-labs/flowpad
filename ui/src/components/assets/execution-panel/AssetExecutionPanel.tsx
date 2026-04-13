import { AgenticProcess, FlowElementTypes } from '@sdk';
import { useEntity, useEntityData } from '@sdk/react/hooks';
import { X } from 'lucide-react';
import { KeyboardEvent, useEffect, useRef, useState } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ExecutionHandle {
  process: AgenticProcess | null;
  isRunning: boolean;
  send: (message: string) => Promise<void>;
  stop: () => void;
}

interface AssetExecutionPanelProps {
  execution: ExecutionHandle;
  onClose: () => void;
}

// ── Component ──────────────────────────────────────────────────────────────────

/**
 * Generic streaming execution panel for any asset type.
 *
 * Renders streamed FlowData from a running AgenticProcess. Reusable — any asset
 * that produces an AgenticProcess can plug in via the ExecutionHandle interface.
 */
export function AssetExecutionPanel({ execution, onClose }: AssetExecutionPanelProps) {
  const { process, send } = execution;
  const { flowData: items } = useEntityData(process?.typeId ?? null);
  const { data: liveProcess } = useEntity<AgenticProcess>(process?.typeId ?? null);
  const isRunning = !!process && !liveProcess?.waiting_for_prompt;

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new items arrive
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  const handleSend = async () => {
    const message = input.trim();
    if (!message || sending) return;
    setInput('');
    setSending(true);
    try {
      await send(message);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  // Status label
  const statusLabel = isRunning ? 'Running…' : items.length > 0 ? 'Completed' : 'Ready';

  return (
    <div className="flex h-1/2 min-h-0 flex-shrink-0 flex-col border-t bg-background">
      {/* Status bar */}
      <div className="flex h-9 flex-shrink-0 items-center justify-between border-b px-3">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {isRunning && (
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-green-500" />
          )}
          {statusLabel}
        </span>
        <button
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Close panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Output area */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {isRunning ? 'Waiting for output…' : 'Send a message to start the agent.'}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {items.map((item, idx) => {
              const elType = item.elementType;

              if (elType === FlowElementTypes.TEXT || elType === FlowElementTypes.CHAT) {
                return (
                  <p key={idx} className="whitespace-pre-wrap text-sm leading-relaxed">
                    {String(item.data ?? '')}
                  </p>
                );
              }

              if (
                elType === FlowElementTypes.SHELL_OUTPUT ||
                elType === FlowElementTypes.SHELL_INPUT ||
                elType === FlowElementTypes.SHELL
              ) {
                return (
                  <pre
                    key={idx}
                    className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs leading-relaxed"
                  >
                    {String(item.data ?? '')}
                  </pre>
                );
              }

              if (elType === FlowElementTypes.ERROR) {
                return (
                  <pre
                    key={idx}
                    className="overflow-x-auto rounded-md bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive"
                  >
                    {String(item.data ?? '')}
                  </pre>
                );
              }

              // Skip state/control events (mode, phase, status, etc.)
              return null;
            })}
          </div>
        )}
      </div>

      {/* Input row */}
      <div className="flex flex-shrink-0 items-end gap-2 border-t px-3 py-2">
        <textarea
          className="min-h-[36px] flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sending}
        />
        <button
          onClick={() => void handleSend()}
          disabled={!input.trim() || sending}
          className="flex h-9 flex-shrink-0 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}

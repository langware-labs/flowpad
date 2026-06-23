import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import {
  agenticProcessName,
  processIdFromTypeId,
  resolveAgenticProcessName,
} from '@src/navigation/agentic-process-open';
import type { NotificationData } from './types';
import { runCommand } from './commands';

/**
 * For a notification whose subject (`typeId`) is an agentic process, show the
 * process one-liner (its session title / shell label) plus an "open" icon that
 * opens it exactly like a click in the footer's process list — live terminal for
 * a visible worker, transcript lens for a headless one (the `process.open`
 * command, bound in `command-bridge`). Renders nothing for non-process
 * notifications.
 */
export function NotificationProcessLine({ data }: { data: NotificationData }) {
  const processId = processIdFromTypeId(data.typeId);
  // The process / session / shell are usually cold here; warm them, then re-read
  // the (non-reactive) cache name once they land. Skip the fetch when the name
  // already resolves — e.g. the footer's process list warmed the same id.
  const [, bumpName] = useState(0);
  useEffect(() => {
    if (!processId || agenticProcessName(processId)) return;
    let cancelled = false;
    void resolveAgenticProcessName(processId).then(() => {
      if (!cancelled) bumpName((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [processId]);

  if (!processId) return null;
  const name = agenticProcessName(processId) ?? processId.slice(0, 8);

  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      <span className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
        {name}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          runCommand('process.open', { processId }, { id: data.id });
        }}
        title="Open process"
        aria-label="Open process"
        className="flex-shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

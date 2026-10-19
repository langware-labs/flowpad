import { useCallback, useSyncExternalStore } from 'react';
import { dataManager, type AgenticProcess } from '@sdk';
import { ContextEntityChip } from '@src/components/conversation/EntityChip';

const isSource = (type: string) => type === 'conversation' || type === 'flow_message';

/** The conversation and/or message a session was started from — one chip each, only when attached. */
export function ProcessSourceChips({ process }: { process: AgenticProcess }) {
  // Own subscription: re-render when the session's attached sources change, not on every toolbar tick.
  const key = useSyncExternalStore(
    useCallback((cb) => dataManager.subscribe(process.typeId, cb, false), [process]),
    () =>
      (process.sharedContextEntities ?? [])
        .filter((tid) => isSource(tid.type))
        .map(String)
        .join(','),
  );
  if (!key) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1" data-testid="process-source-chips">
      {(process.sharedContextEntities ?? [])
        .filter((tid) => isSource(tid.type))
        .map((tid) => (
          <span key={String(tid)} data-testid={`process-source-${tid.type}`}>
            <ContextEntityChip typeId={tid} />
          </span>
        ))}
    </span>
  );
}

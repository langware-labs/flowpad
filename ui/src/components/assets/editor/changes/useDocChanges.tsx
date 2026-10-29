import { t } from '@lingui/core/macro';
import { useCallback, useMemo } from 'react';
import { Loader2, WandSparkles, X } from 'lucide-react';
import type { ExtraSideTab } from '@src/components/milkdown-editor/EditorWithSidePanel';
import type { RequestChangeOpts, RequestedChange } from '@src/components/milkdown-editor/MilkdownEditor';
import type { ChangeMark } from '@src/components/milkdown-editor/plugins/change-marks';
import { useSideWindows } from '@src/navigation/useSideWindows';
import { useDocChangesStore, type DocChangeList } from './use-doc-changes-store';
import { useDocChangesWorker } from './useDocChangesWorker';

export const CHANGES_SIDE_TAB_ID = 'changes';

function ChangesPanel({
  list,
  starting,
  hasSession,
  onExecute,
  onNewSession,
  onClear,
  onRemove,
  onOpen,
}: {
  list: DocChangeList;
  starting: boolean;
  hasSession: boolean;
  onExecute: () => void;
  onNewSession: () => void;
  onClear: () => void;
  onRemove: (id: string) => void;
  onOpen: () => void;
}) {
  const running = !!list.sentTo;
  const nSent = list.changes.filter((c) => c.sent).length;
  const nNew = list.changes.length - nSent;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="changes-panel">
      {running && (
        <div className="border-b p-2">
          <div
            className="flex items-center gap-2 rounded-md bg-muted px-2 py-1.5 text-xs"
            data-testid="changes-running"
          >
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" />
            <span className="flex-1">
              {nSent === 1 ? t`Worker is applying 1 change` : t`Worker is applying ${nSent} changes`}
            </span>
            <button type="button" onClick={onOpen} className="font-medium text-primary hover:underline">
              {t`Open session`}
            </button>
            <button
              type="button"
              onClick={onClear}
              title={t`Clear the list without waiting for the worker`}
              className="text-muted-foreground hover:text-foreground hover:underline"
              data-testid="changes-clear-sent"
            >
              {t`Clear`}
            </button>
          </div>
        </div>
      )}
      {nNew > 0 && (
        <div className="flex items-center gap-2 border-b p-2">
          {!running && (
            <button
              type="button"
              onClick={onClear}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
              data-testid="changes-clear"
            >
              {t`Clear`}
            </button>
          )}
          {hasSession && !running && list.lastFailed && (
            <button
              type="button"
              onClick={onNewSession}
              disabled={starting}
              title={t`The last run did not finish — run these changes in a fresh worker`}
              className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-60"
              data-testid="changes-new-session"
            >
              {t`New session`}
            </button>
          )}
          {hasSession && !running && (
            <button
              type="button"
              onClick={onOpen}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              {t`Open session`}
            </button>
          )}
          <button
            type="button"
            onClick={onExecute}
            disabled={starting}
            data-testid="changes-execute"
            className="ms-auto flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60"
          >
            {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <WandSparkles className="h-3.5 w-3.5" />}
            {nNew === 1 ? t`Execute 1 change` : t`Execute ${nNew} changes`}
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {nNew === 0 && !running && (
          <div className="px-1 text-[11px] text-muted-foreground">
            {t`Select text and press the wand to add a change. Nothing runs until Execute.`}
          </div>
        )}
        {list.changes.map((c, i) => (
          <div key={c.id} className="flex flex-col gap-1 rounded-md border border-border p-2" data-testid="change-row">
            <div className="flex items-start gap-2">
              <span className="mt-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                {i + 1}
              </span>
              <span className="line-clamp-2 flex-1 border-s-2 border-border ps-2 text-xs italic text-muted-foreground">
                “{c.quote}”
              </span>
              {c.sent ? (
                <span className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">{t`Sent`}</span>
              ) : (
                <button
                  type="button"
                  aria-label={t`Remove change`}
                  onClick={() => onRemove(c.id)}
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <div className="ps-6 text-sm text-foreground">{c.instruction}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * "Change this" for one doc: the handler the editor's wand calls, and the
 * Changes side tab that lists the queued requests and runs them.
 */
export function useDocChanges(
  doc: string | null,
  docName: string,
  docFile: string,
  /** The worker finished a run — the host re-reads the file it edited. */
  onRunFinished?: () => void,
) {
  const { open: openSideWindow } = useSideWindows();
  const worker = useDocChangesWorker(doc, docName, docFile, onRunFinished);
  const { list, starting, execute, open, hasSession } = worker;

  const onRequestChange = useCallback(
    (change: RequestedChange, opts?: RequestChangeOpts) => {
      if (!doc) return;
      useDocChangesStore.getState().add(doc, change);
      openSideWindow(CHANGES_SIDE_TAB_ID);
      if (opts?.runNow) void execute();
    },
    [doc, openSideWindow, execute],
  );

  const n = list.changes.length;
  const changesTab = useMemo<ExtraSideTab>(
    () => ({
      id: CHANGES_SIDE_TAB_ID,
      label: n > 0 ? `${t`Changes`} ${n}` : t`Changes`,
      icon: WandSparkles,
      description: t`Changes queued on this doc`,
      availableInNonAdvanced: true,
      panel: (
        <ChangesPanel
          list={list}
          starting={starting}
          hasSession={hasSession}
          onExecute={() => void execute()}
          onNewSession={() => void execute({ newSession: true })}
          onClear={() => doc && useDocChangesStore.getState().clear(doc)}
          onRemove={(id) => doc && useDocChangesStore.getState().remove(doc, id)}
          onOpen={open}
        />
      ),
    }),
    [n, list, starting, hasSession, execute, open, doc],
  );

  // The same numbers as the list rows, drawn on the text they are about.
  const changeMarks = useMemo<ChangeMark[]>(
    () => list.changes.map((c, i) => ({ id: c.id, quote: c.quote, from: c.from, to: c.to, n: i + 1, sent: c.sent })),
    [list.changes],
  );

  return {
    changesTab: doc ? changesTab : null,
    onRequestChange: doc ? onRequestChange : undefined,
    changeMarks: doc ? changeMarks : undefined,
  };
}

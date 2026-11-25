import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { addMdSyncSource, MdSyncState, syncMd, type MdSyncStale } from '@sdk';
import { useMdSync } from '@sdk/react/hooks';
import { Row, smallBtn } from '@src/components/footer/BrowserChip';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { describeApiError } from '@src/lib/error-message';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useState } from 'react';

/** How many unsynced sources the list shows before "+ N more". */
const SOURCES_SHOWN = 3;

const spinner = <Loader2 className="h-3 w-3 shrink-0 animate-spin" />;

/** The markdown mark: a framed M and a down arrow. Drawn with `currentColor`. */
function MdIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 4 24 16"
      style={{ width: 18, height: 12 }}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="1.5" y="5" width="21" height="14" rx="2" />
      <path d="M5.5 15V9l2.5 3 2.5-3v6" />
      <path d="M16.5 9v6" />
      <path d="m14 12.5 2.5 2.5 2.5-2.5" />
    </svg>
  );
}

/** A stale group as one line: the file (or the skill) that is behind, and what it is behind. */
function StaleRow({ stale }: { stale: MdSyncStale }) {
  const target = stale.targets[0] ?? '';
  const single = !target.includes('/');
  return (
    <Row
      testId={`md-sync-stale-${stale.name}`}
      icon={<AlertTriangle className="h-3.5 w-3.5 shrink-0 text-yellow-500" />}
      name={single ? target || stale.name : stale.name}
      note={single ? <Trans>behind {stale.source}</Trans> : <Trans>{target.split('/')[0]} copy behind</Trans>}
      tone="muted"
    />
  );
}

/**
 * Footer chip: the project's harness markdown files (CLAUDE.md, AGENTS.md, skills) are out of sync,
 * as `syncmd` reports it. Shown ONLY when there is something to do: files a sync would write, or
 * sources that have files here and are not synced. A missing syncmd is a standard warning instead
 * (`useWarnings`). It renders the md-sync store and calls its actions.
 */
export function MdSyncChip() {
  const { t } = useLingui();
  const status = useMdSync();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [said, setSaid] = useState('');
  const [written, setWritten] = useState<number | null>(null);
  const [allSources, setAllSources] = useState(false);

  const ok = status?.state === MdSyncState.OK;
  const stale = ok ? status.stale : [];
  const unsynced = ok ? status.unsynced : [];
  // While it is open it stays, so the answer to a Sync is read where it was asked.
  if (!open && !stale.length && !unsynced.length) return null;

  const files = stale.reduce((n, group) => n + group.targets.length, 0);
  const filesWord = plural(files, { one: '# file', other: '# files' });
  const sourcesWord = plural(unsynced.length, { one: '# source', other: '# sources' });
  const label = t`${filesWord} out of sync · ${sourcesWord} not synced`;
  const act = async (name: string, work: () => Promise<void>) => {
    setBusy(name);
    setSaid('');
    try {
      await work();
    } catch (err) {
      setSaid(describeApiError(err, t`Could not run syncmd.`).message);
    } finally {
      setBusy('');
    }
  };
  const sync = () =>
    act('sync', async () => {
      const answer = await syncMd();
      if (answer?.state === MdSyncState.OK) setWritten(answer.written ?? 0);
    });
  /** The header's right side: what the sync wrote, the sync running, or the Sync button. */
  const headerAction = () => {
    if (written !== null)
      return (
        <span className="text-[11px] font-normal text-muted-foreground" data-testid="md-sync-done">
          <span className="text-green-600 dark:text-green-400">✓</span> {plural(written, { one: '# file updated', other: '# files updated' })}
        </span>
      );
    if (busy === 'sync') return spinner;
    if (!stale.length) return null;
    return (
      <button
        type="button"
        data-testid="md-sync-run"
        disabled={!!busy}
        onClick={() => void sync()}
        className="rounded bg-primary px-2 py-0.5 text-[11px] text-primary-foreground"
      >
        <Trans>Sync {filesWord}</Trans>
      </button>
    );
  };
  const detail = said || (status?.state === MdSyncState.ERROR ? status.detail : '');
  const sources = allSources ? unsynced : unsynced.slice(0, SOURCES_SHOWN);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setWritten(null);
          setSaid('');
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="footer-md-sync-chip"
          aria-label={t`Markdown files out of sync`}
          title={label}
          className="relative flex shrink-0 items-center rounded-sm border border-transparent px-1.5 text-[10px] text-muted-foreground hover:bg-accent"
        >
          <span className="relative inline-flex">
            <MdIcon className="shrink-0" />
            <AlertTriangle className="absolute -end-[5px] -top-1 h-2 w-2 text-yellow-500" strokeWidth={2.5} />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0" data-testid="md-sync-popover">
        <div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold">
          <span className="flex-1">
            <Trans>Markdown sync</Trans>
          </span>
          {headerAction()}
        </div>
        {stale.map((group) => (
          <StaleRow key={`${group.kind}:${group.name}`} stale={group} />
        ))}
        {unsynced.length > 0 && (
          <>
            <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
              <Trans>Not synced · {sourcesWord}</Trans>
            </div>
            {sources.map((u) => (
              <Row
                key={u.source}
                testId={`md-sync-source-${u.source}`}
                icon={<MdIcon className="shrink-0 text-muted-foreground" />}
                name={u.source}
                note={u.paths.length === 1 ? u.paths[0] : plural(u.paths.length, { one: '# file', other: '# files' })}
                tone="muted"
                action={
                  busy === u.source ? (
                    spinner
                  ) : (
                    <button
                      type="button"
                      className={smallBtn}
                      disabled={!!busy}
                      onClick={() =>
                        void act(u.source, async () => {
                          await addMdSyncSource(u.source);
                          // The new source may have files to sync: the Sync button comes back.
                          setWritten(null);
                        })
                      }
                      data-testid={`md-sync-add-${u.source}`}
                    >
                      <Trans>Add</Trans>
                    </button>
                  )
                }
              />
            ))}
            {unsynced.length > sources.length && (
              <button
                type="button"
                data-testid="md-sync-more"
                onClick={() => setAllSources(true)}
                className="flex w-full border-t px-3 py-1.5 text-xs text-primary hover:bg-accent"
              >
                <Trans>+ {unsynced.length - sources.length} more</Trans>
              </button>
            )}
          </>
        )}
        {detail && <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">{detail}</div>}
      </PopoverContent>
    </Popover>
  );
}

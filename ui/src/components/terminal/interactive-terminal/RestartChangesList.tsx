/**
 * RestartChangesList — the hover card body of the glowing Restart button: only
 * the launch settings that changed since the session started (one short summary
 * each), and a link to the full Loaded vs Current view (Command Status).
 *
 * Reads `process.restart_changes`, which the process already carries — no fetch.
 */
import { AgenticProcess } from '@sdk';
import { Trans } from '@lingui/react/macro';

type RestartChange = NonNullable<AgenticProcess['restart_changes']>[number];

/** A changed field's display name: `add_dirs` → "add dirs". */
export const changeLabel = (c: RestartChange) => c.field.replace(/_/g, ' ');

export function RestartChangesList({ process, onShowAll }: { process: AgenticProcess; onShowAll: () => void }) {
  const changes = process.restart_changes ?? [];
  return (
    <div data-testid="restart-changes-card">
      <div className="border-b border-border px-3 py-2 font-medium">
        <Trans>Restart to apply what changed since this session started</Trans>
      </div>
      {changes.length === 0 ? (
        <div className="px-3 py-2 text-muted-foreground">
          <Trans>Settings changed since this session started.</Trans>
        </div>
      ) : (
        <ul className="max-h-64 overflow-auto">
          {changes.map((c) => {
            const raw = `${c.loaded} → ${c.current}`;
            return (
              <li
                key={c.field}
                className="border-t border-border bg-amber-500/10 px-3 py-1.5 first:border-t-0"
                title={raw}
                data-testid="restart-change-row"
              >
                <span className="font-mono text-[11px] text-foreground/90">{changeLabel(c)}</span>
                <span className="ms-2 break-all text-muted-foreground">{c.summary ?? raw}</span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="border-t border-border px-3 py-1.5 text-end">
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={onShowAll}
          data-testid="restart-changes-show-all"
        >
          <Trans>See all settings</Trans>
        </button>
      </div>
    </div>
  );
}

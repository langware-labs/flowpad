import { Trans } from '@lingui/react/macro';
import type { GitignoredReference } from '@sdk';
import { Button } from '@src/components/ui/button';

/**
 * A share that would copy files git excludes (a data source's local copy, an env file, rows kept out of
 * git) — shown BEFORE anything is sent. The person sees what, and decides: sending anyway is allowed.
 * Shared by every surface that packs a copy (send to a conversation, download a `.flowmsg`).
 */
export function GitignoredNotice({
  items,
  busy,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  items: readonly GitignoredReference[];
  busy: boolean;
  confirmLabel: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
      data-testid="share-gitignored"
    >
      <p className="font-medium">
        <Trans>These are kept out of git and may be private. They would be sent too:</Trans>
      </p>
      <ul className="list-disc ps-4">
        {items.map((item) => (
          <li key={item.type_id} className="break-all">
            <span className="font-mono">{item.type_id}</span>
            {': '}
            {item.paths.map((p) => (p === '.' ? '(all of it)' : p)).join(', ')}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onConfirm} disabled={busy} data-testid="share-gitignored-confirm">
          {confirmLabel}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </div>
  );
}

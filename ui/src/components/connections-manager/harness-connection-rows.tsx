import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ConnectionState, type ConnectionSpec } from '@sdk';
import { cn } from '@src/lib/utils';
import { HarnessMark } from './harness-mark';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { TableCell, TableRow } from '../ui/table';

/**
 * The harness device logins — Claude, Codex, Copilot, OpenCode — as Connections rows.
 *
 * They are the credentials the assistants actually run on, and they were the one
 * kind of connection this table did not show.
 *
 * **A presenter.** The rows arrive already composed, from the single
 * `connections` read; this file only draws them. It used to resolve them itself
 * through `useLlmSources`, which cost one funding read plus a probe per harness
 * — five requests to paint four cells that the consolidated list already
 * answers. More importantly, resolving here meant the browser held a second
 * opinion about what "signed in" means, and that copy had already drifted from
 * the backend's on the strongest verdict it can issue.
 *
 * **Only what is installed, and only what was asked.** The backend drops a
 * harness whose CLI is not on this machine — a sign-in status for something you
 * never installed is a question about nothing — and the screen asks it to probe
 * the ones that are, so the rows say "Signed in" rather than "Not checked".
 *
 * **Read-only on purpose.** Signing in is a vendor CLI flow the login modal already
 * owns end to end — the device code, Claude's paste-back, the provider picker, the
 * probe. So the row reports and Details hands off. That also sidesteps an asymmetry
 * the row would otherwise have to explain: there is no logout for a harness at any
 * tier, because signing out means running the vendor's own CLI in your own terminal.
 */

/**
 * State → how it reads. Keyed by the enum, so a new state is a type error rather
 * than a row that silently falls through to the neutral dot.
 *
 * "Not checked" is a first-class answer, not a hedge: the backing field is not
 * persisted, so "nobody has asked" is the COMMON state after any restart, and
 * rendering it as "not connected" tells a signed-in user they are signed out
 * every time the backend restarts.
 */
const STATE_VISUAL: Record<ConnectionState, { text: MessageDescriptor; dot: string }> = {
  [ConnectionState.Connected]: { text: msg`Signed in`, dot: 'bg-emerald-400' },
  [ConnectionState.Disconnected]: { text: msg`Signed out`, dot: 'bg-muted-foreground/40' },
  [ConnectionState.NeedsReauth]: { text: msg`Reconnect needed`, dot: 'bg-red-500' },
  [ConnectionState.Unknown]: { text: msg`Not checked`, dot: 'bg-muted-foreground/40' },
};

export function HarnessConnectionRows({
  rows,
  onDetails,
}: {
  rows: ConnectionSpec[];
  onDetails?: (worker: string) => void;
}) {
  const { t } = useLingui();

  return (
    <>
      {rows.map((row) => {
        const worker = row.provider;
        const visual = STATE_VISUAL[row.state] ?? STATE_VISUAL[ConnectionState.Unknown];

        return (
          <TableRow key={`harness:${worker}`} data-testid={`connection-row-harness-${worker}`}>
            <TableCell className="font-medium">
              <div className="flex items-center gap-2">
                <HarnessMark worker={worker} />
                <span>{row.display_name || worker}</span>
              </div>
            </TableCell>

            <TableCell>
              {/* The account when the vendor named one, the mechanism otherwise.
                  NOT "Device code": that label belongs to the RFC 8628 OAuth device
                  grant, which exactly one registered provider uses. This is the
                  vendor CLI's own OAuth session — same words, different mechanism. */}
              <Badge
                variant="outline"
                className="text-xs font-normal"
                title={row.identity || t`The assistant's own CLI sign-in, kept by the vendor on this machine`}
                data-testid={`connection-kind-harness-${worker}`}
              >
                {row.account || <Trans>CLI login</Trans>}
              </Badge>
            </TableCell>

            {/* Access requested and Used by are both empty: a harness login is
                machine-level, asks for no per-project scopes, and attaches to no
                project. */}
            <TableCell className="text-sm text-muted-foreground">—</TableCell>

            <TableCell>
              <div className="flex items-center gap-2 text-sm">
                <span className={cn('h-2 w-2 shrink-0 rounded-full', visual.dot)} />
                {/* One short word in the cell — a wrapping label is what made the two
                    halves of this table read as two different tables. The backend owns
                    the sentence and it is rendered verbatim, in the title. */}
                <span
                  className="whitespace-nowrap"
                  title={row.detail || undefined}
                  data-testid={`connection-status-harness-${worker}`}
                >
                  {i18n._(visual.text)}
                </span>
              </div>
            </TableCell>

            <TableCell className="text-sm text-muted-foreground">—</TableCell>

            <TableCell className="text-end">
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                onClick={() => onDetails?.(worker)}
                data-testid={`connection-harness-details-${worker}`}
              >
                <Trans>Details</Trans>
              </Button>
            </TableCell>
          </TableRow>
        );
      })}
    </>
  );
}

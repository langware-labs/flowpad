import { i18n } from '@lingui/core';
import { Trans } from '@lingui/react/macro';
import { ConnectionState, type ConnectionSpec } from '@sdk';
import { cn } from '@src/lib/utils';
import { HarnessMark } from './harness-mark';
import { STATE_VISUAL } from './connection-state-visual';
import { Button } from '../ui/button';
import { TableCell, TableRow } from '../ui/table';
import { SignInMethodIcon } from './sign-in-method';
import { MachineWideCell, TextActionCell } from './machine-wide-cell';

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


export function HarnessConnectionRows({
  rows,
  onDetails,
}: {
  rows: ConnectionSpec[];
  onDetails?: (worker: string) => void;
}) {
  return (
    <>
      {rows.map((row) => {
        const worker = row.provider;
        const visual = STATE_VISUAL[row.state] ?? STATE_VISUAL[ConnectionState.Unknown];
        const needsYou = row.state === ConnectionState.Disconnected || row.state === ConnectionState.NeedsReauth;

        return (
          <TableRow key={`harness:${worker}`} data-testid={`connection-row-harness-${worker}`}>
            <TableCell className="font-medium">
              <div className="flex items-center gap-2">
                <HarnessMark worker={worker} />
                <span>{row.display_name || worker}</span>
              </div>
            </TableCell>

            <TableCell>
              {/* The CLI's own login on this machine. What account and plan it is
                  on — when the vendor says — goes in the tooltip. */}
              <SignInMethodIcon
                method={row.sign_in || 'device'}
                lines={[row.account, row.identity]}
                testId={`connection-kind-harness-${worker}`}
              />
            </TableCell>

            {/* A harness login asks for no per-project scopes, so Access requested is
                empty; it is machine-level, so Used by says so rather than "—". */}
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

            <MachineWideCell />

            <TextActionCell>
              {/* Quiet while it works; the outlined call to action only when the
                  login needs you — the same rule every other row follows. */}
              <Button
                variant={needsYou ? 'outline' : 'ghost'}
                size="sm"
                className={cn('h-7', !needsYou && 'text-muted-foreground hover:text-foreground')}
                onClick={() => onDetails?.(worker)}
                data-testid={`connection-harness-details-${worker}`}
              >
                <Trans>Details</Trans>
              </Button>
            </TextActionCell>
          </TableRow>
        );
      })}
    </>
  );
}
